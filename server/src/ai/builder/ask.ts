import type { ZodType } from 'zod';
import { parseJsonLoose } from '../anthropic.js';
import { estimateTokens, LlmError, llmMessage, type LlmClient } from '../llm.js';
import { repairSuffix } from './prompts.js';

export interface AskResult<T> { value?: T; reason?: string; usage: { inputTokens: number; outputTokens: number; calls: number }; attempts: number }

/**
 * One validated model answer: ask, parse JSON, check the schema and the caller's semantic rules, and on failure re-ask with the reasons up to `maxRepairs`
 * times. Never throws for model problems; `reason` carries the user-facing sentence when the answer could not be obtained. Aborts surface as an Error('aborted').
 */
export async function askJson<T>(o: {
  llm: LlmClient; stage: string; system: string; user: string; maxTokens: number; schema: ZodType<T>; semantic?: (v: T) => string[];
  inputTokens: number; maxRepairs: number; signal?: AbortSignal;
}): Promise<AskResult<T>> {
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  let problems: string[] = [];
  let reason = llmMessage('malformed');
  for (let attempt = 1; attempt <= 1 + o.maxRepairs; attempt++) {
    const user = attempt === 1 ? o.user : o.user + repairSuffix(problems);
    if (estimateTokens(o.system + user) > o.inputTokens) return { reason: llmMessage('budget'), usage, attempts: attempt - 1 };
    try {
      const res = await o.llm.complete({ stage: o.stage, system: o.system, user, maxTokens: o.maxTokens, attempt }, o.signal);
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      usage.calls++;
      if (res.stopReason === 'max_tokens') { problems = ['the answer was cut off; make it shorter']; reason = 'The AI answer was cut off.'; continue; }
      let json: unknown;
      try { json = parseJsonLoose(res.text); } catch { problems = ['the answer was not valid JSON']; reason = llmMessage('malformed'); continue; }
      const parsed = o.schema.safeParse(json);
      if (!parsed.success) { problems = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`); reason = llmMessage('malformed'); continue; }
      const sem = o.semantic?.(parsed.data) ?? [];
      if (sem.length) { problems = sem; reason = `The AI answer failed checks: ${sem[0]}`; continue; }
      return { value: parsed.data, usage, attempts: attempt };
    } catch (e) {
      if (e instanceof LlmError) {
        if (e.kind === 'aborted') throw new Error('aborted');
        reason = llmMessage(e.kind);
        if (!e.retryable) return { reason, usage, attempts: attempt };
        problems = ['the answer was empty'];
        continue;
      }
      return { reason: llmMessage('provider'), usage, attempts: attempt };
    }
  }
  return { reason, usage, attempts: 1 + o.maxRepairs };
}
