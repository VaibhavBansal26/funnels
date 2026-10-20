import Anthropic from '@anthropic-ai/sdk';
import { altTextPrompt, funnelPrompt, headlinesPrompt, insightsPrompt, rewritePrompt, SYSTEM } from './prompts.js';
import { summaryPrompt, type SummaryEvidence } from './summary.js';
import type { AiProvider, AltTextInput, GenerateFunnelInput, HeadlineInput, InsightInput, RewriteInput } from './types.js';

/** The small slice of the SDK this provider uses, so tests can inject a fake client. */
export interface MessagesClient {
  messages: {
    create(args: { model: string; max_tokens: number; system: string; messages: { role: 'user'; content: string }[] }): Promise<{
      content: { type: string; text?: string }[];
      stop_reason?: string | null;
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

  constructor(opts: { apiKey?: string; model: string; client?: MessagesClient }) {
    this.client = opts.client ?? (new Anthropic({ apiKey: opts.apiKey }) as unknown as MessagesClient);
    this.model = opts.model;
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
