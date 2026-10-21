import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from '../../src/ai/llm.js';
import type { AiProvider } from '../../src/ai/types.js';
import { HeuristicProvider } from '../../src/ai/heuristic.js';

export type Reply = string | object | Error | LlmResponse | ((req: LlmRequest, n: number) => Reply | Promise<Reply>);

/**
 * A scripted model for tests: no network. `script` maps a stage (or stage prefix such as "copy:") to a reply; replies are JSON text, an object (serialised),
 * an Error (thrown) or a function of the request and the call count. Records every request, with the user prompt, for assertions on what the model was told.
 */
export class ScriptedLlm implements LlmClient {
  readonly model = 'fake-model-1';
  calls: LlmRequest[] = [];
  constructor(public script: Record<string, Reply> = {}, private tokens = { inputTokens: 400, outputTokens: 300 }) {}
  async complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    this.calls.push(req);
    if (signal?.aborted) throw new LlmError('aborted', 'aborted');
    const key = Object.keys(this.script).filter((k) => req.stage === k || req.stage.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const n = this.calls.filter((c) => c.stage === req.stage).length;
    let reply: Reply = key ? this.script[key]! : goodReply(req);
    if (typeof reply === 'function') reply = await reply(req, n);
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'object' && 'usage' in reply && 'text' in reply) return reply as LlmResponse;
    return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), usage: this.tokens, stopReason: 'end_turn', model: this.model };
  }
}

export class ScriptedProvider implements AiProvider {
  readonly name: string = 'scripted';
  funnelCopy: AiProvider['funnelCopy'];
  rewrite: AiProvider['rewrite'];
  headlines: AiProvider['headlines'];
  insights: AiProvider['insights'];
  altText: AiProvider['altText'];
  summary: AiProvider['summary'];
  constructor(public llm: ScriptedLlm) {
    const h = new HeuristicProvider();
    this.funnelCopy = h.funnelCopy;
    this.rewrite = h.rewrite;
    this.headlines = h.headlines;
    this.insights = h.insights;
    this.altText = h.altText;
    this.summary = h.summary;
  }
}

const SAFE_FAQ = [{ q: 'What happens next?', a: 'You will get a confirmation by email.' }];

/** A well-behaved answer for any stage; tests override single stages to make them bad. */
export function goodReply(req: LlmRequest): object {
  if (req.stage === 'brief') return { business: 'Corner Bakery', offer: 'Custom celebration cakes', audience: 'Families planning birthdays', tone: 'friendly', goal: 'leads', industry: 'food', currency: 'USD', priceMin: null, priceMax: null, constraints: [], avoid: [], language: 'en', regulated: 'none', assumptions: ['Written in a friendly voice.'] };
  if (req.stage === 'strategy') return { funnelType: 'local_lead', rationale: 'A short enquiry page suits a local business.', steps: [{ kind: 'landing' }, { kind: 'thankyou' }] };
  const kind = req.stage.split(':')[1] ?? 'landing';
  const isForm = /Page has ONE form|ONE form/.test(req.user);
  return {
    eyebrow: 'Welcome', headline: kind === 'thankyou' ? 'Thanks, we have your request' : 'Cakes made for your celebration', subheadline: 'Tell us what you need and we will reply soon.',
    bullets: ['Made to order', 'Simple ordering', 'Friendly service'], cta: kind === 'thankyou' ? 'Done' : 'Send my request', faq: kind === 'thankyou' ? [] : SAFE_FAQ,
    proofPrompts: kind === 'thankyou' ? [] : ['Ask a customer what they liked about their cake.'],
    form: isForm ? { fields: [{ label: 'Name', type: 'name', required: true }, { label: 'Email', type: 'email', required: true }, { label: 'Event date', type: 'text', required: false }], submitLabel: 'Send my request' } : null,
    illustration: { kind: 'discs', alt: 'Decorative overlapping coloured circles' },
  };
}
