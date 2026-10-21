import Anthropic from '@anthropic-ai/sdk';
import { altTextPrompt, funnelPrompt, headlinesPrompt, insightsPrompt, rewritePrompt, SYSTEM } from './prompts.js';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from './llm.js';
import { summaryPrompt, type SummaryEvidence } from './summary.js';
import type { AiProvider, AltTextInput, GenerateFunnelInput, HeadlineInput, InsightInput, RewriteInput } from './types.js';

/** The small slice of the SDK this provider uses, so tests can inject a fake client. */
export interface MessagesClient {
  messages: {
    create(args: { model: string; max_tokens: number; system: string; messages: { role: 'user'; content: string }[] }, opts?: { signal?: AbortSignal; timeout?: number }): Promise<{
      content: { type: string; text?: string }[];
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    }>;
  };
}

/** Extracts the first JSON value from model text, tolerating code fences and surrounding prose. Throws when none is found. */
export function parseJsonLoose(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\s*|\s*```$/gim, '').trim();
  if (!stripped) throw new Error('empty model output');
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.search(/[{[]/);
    const end = Math.max(stripped.lastIndexOf('}'), stripped.lastIndexOf(']'));
    if (start === -1 || end <= start) throw new Error('model output contains no JSON');
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private client: MessagesClient;

  readonly llm: LlmClient;

  constructor(opts: { apiKey?: string; model: string; client?: MessagesClient; timeoutMs?: number }) {
    this.client = opts.client ?? (new Anthropic({ apiKey: opts.apiKey, maxRetries: 1 }) as unknown as MessagesClient);
    this.model = opts.model;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const client = this.client;
    const model = this.model;
    this.llm = {
      model,
      async complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
        let res;
        try {
          res = await client.messages.create({ model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.user }] }, { signal, timeout: timeoutMs });
        } catch (e) {
          const err = e as { name?: string; message?: string; status?: number };
          if (signal?.aborted || err.name === 'AbortError') throw new LlmError('aborted', 'cancelled');
          if (err.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(err.message ?? '')) throw new LlmError('timeout', 'model call timed out');
          throw new LlmError('provider', `model call failed${err.status ? ` (${err.status})` : ''}`);
        }
        if (res.stop_reason === 'refusal') throw new LlmError('refusal', 'model refused');
        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
        if (!text.trim()) throw new LlmError('empty', 'empty model output');
        return { text, usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 }, stopReason: res.stop_reason, model: res.model ?? model };
      },
    };
  }
  private model: string;

  private async ask(prompt: string, maxTokens: number): Promise<unknown> {
    const res = await this.client.messages.create({ model: this.model, max_tokens: maxTokens, system: SYSTEM, messages: [{ role: 'user', content: prompt }] });
    if (res.stop_reason === 'refusal') throw new Error('model refused');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    return parseJsonLoose(text);
  }

  funnelCopy = (i: GenerateFunnelInput) => this.ask(funnelPrompt(i), 3000);
  rewrite = (i: RewriteInput) => this.ask(rewritePrompt(i), 1500);
  headlines = (i: HeadlineInput) => this.ask(headlinesPrompt(i), 600);
  insights = (i: InsightInput) => this.ask(insightsPrompt(i), 1200);
  altText = (i: AltTextInput) => this.ask(altTextPrompt(i), 200);
  summary = (e: SummaryEvidence) => this.ask(summaryPrompt(e), 1200);
}
