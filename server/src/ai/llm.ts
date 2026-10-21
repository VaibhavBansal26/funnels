/**
 * The low-level model interface of the multi-stage builder: one request in, text and token use out. The builder owns parsing, validation, repair and
 * fallback, so a provider only has to move text. `AnthropicProvider.llm` implements it with the SDK; tests inject a scripted fake (test/support/fakellm.ts).
 */
export interface LlmRequest {
  /** Pipeline stage, for logs and for scripted fakes ("brief", "strategy", "copy:optin", "edit", "section"). */
  stage: string;
  system: string;
  user: string;
  maxTokens: number;
  /** 1 for the first attempt, 2.. for repair retries. */
  attempt: number;
}

export interface LlmResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  stopReason?: string | null;
  model: string;
}

export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export type LlmFailure = 'timeout' | 'refusal' | 'empty' | 'malformed' | 'provider' | 'aborted' | 'budget';

/** A model call that did not produce usable text. `kind` drives the user-facing message and whether a repair retry makes sense. */
export class LlmError extends Error {
  constructor(public kind: LlmFailure, message: string) {
    super(message);
    this.name = 'LlmError';
  }
  /** Re-asking can help for malformed or empty text; a refusal, a timeout, an outage or a budget stop will not improve. */
  get retryable(): boolean {
    return this.kind === 'malformed' || this.kind === 'empty';
  }
}

/** Rough token estimate (4 characters per token) used for budgets before a call; real usage comes back in the response. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** User-facing sentence for a failure kind (the wizard and the builder panel show these). */
export function llmMessage(kind: LlmFailure): string {
  switch (kind) {
    case 'timeout': return 'The AI model took too long to answer.';
    case 'refusal': return 'The AI model declined to write this. Try rephrasing your description.';
    case 'empty': return 'The AI model returned nothing.';
    case 'malformed': return 'The AI model answered in a format we could not use.';
    case 'budget': return 'This request is larger than the AI budget allows.';
    case 'aborted': return 'The request was cancelled.';
    default: return 'The AI model is unavailable right now.';
  }
}
