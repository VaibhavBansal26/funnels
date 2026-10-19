import { useState } from 'react';
import { api } from '../api/client';
import { useMutate } from '../api/hooks';
import { ErrorBanner } from '../components/ui';

type Tone = 'persuasive' | 'concise' | 'friendly' | 'formal';
type Length = 'shorter' | 'same' | 'longer';

const note = (source: string) => <span className="muted small">{source === 'model' ? 'Written by the AI model.' : 'Written by the built-in writer.'} Review before applying.</span>;

/** Rewrite and headline suggestions for the selected text block. Suggestions are only applied when the user clicks Apply. */
export function TextAssist({ text, heading, onApply }: { text: string; heading: boolean; onApply: (t: string) => void }) {
  const [tone, setTone] = useState<Tone>('persuasive');
  const [length, setLength] = useState<Length>('same');
  const rewrite = useMutate(() => api.post<{ text: string; source: string }>('/api/ai/rewrite', { text, tone, length }));
  const ideas = useMutate(() => api.post<{ headlines: string[]; source: string }>('/api/ai/headlines', { topic: text, tone }));
  return (
    <details className="card" style={{ padding: 10, marginBottom: 12 }}>
      <summary><strong>✨ AI assistant</strong></summary>
      <div className="stack" style={{ marginTop: 8 }}>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <div className="field" style={{ margin: 0 }}><label htmlFor="ai-tone">Tone</label>
            <select id="ai-tone" className="input" value={tone} onChange={(e) => setTone(e.target.value as Tone)}>{['persuasive', 'concise', 'friendly', 'formal'].map((t) => <option key={t}>{t}</option>)}</select></div>
          <div className="field" style={{ margin: 0 }}><label htmlFor="ai-length">Length</label>
            <select id="ai-length" className="input" value={length} onChange={(e) => setLength(e.target.value as Length)}><option value="shorter">Shorter</option><option value="same">Same</option><option value="longer">Longer</option></select></div>
        </div>
        <div className="row">
          <button type="button" className="btn sm" disabled={!text.trim() || rewrite.isPending} onClick={() => rewrite.mutate(undefined)}>{rewrite.isPending ? 'Rewriting…' : 'Rewrite'}</button>
          {heading ? <button type="button" className="btn sm" disabled={!text.trim() || ideas.isPending} onClick={() => ideas.mutate(undefined)}>{ideas.isPending ? 'Thinking…' : '5 headline ideas'}</button> : null}
        </div>
        <ErrorBanner error={rewrite.error ?? ideas.error} />
        {rewrite.data ? (
          <div className="stack" aria-label="Rewrite suggestion">
            <blockquote style={{ margin: 0, padding: '6px 10px', borderLeft: '3px solid var(--primary)' }}>{rewrite.data.text}</blockquote>
            {note(rewrite.data.source)}
            <div className="row"><button type="button" className="btn sm primary" onClick={() => { onApply(rewrite.data!.text); rewrite.reset(); }}>Apply</button><button type="button" className="btn sm" onClick={() => rewrite.reset()}>Discard</button></div>
          </div>
        ) : null}
        {ideas.data ? (
          <div className="stack" aria-label="Headline ideas">
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} className="stack">
              {ideas.data.headlines.map((h) => <li key={h}><button type="button" className="btn sm" style={{ textAlign: 'left', width: '100%' }} onClick={() => { onApply(h); ideas.reset(); }}>{h}</button></li>)}
            </ul>
            {note(ideas.data.source)}
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function AltAssist({ src, context, onApply }: { src: string; context: string; onApply: (t: string) => void }) {
  const m = useMutate(() => api.post<{ alt: string; source: string }>('/api/ai/alt-text', { src, context }));
  return (
    <div className="stack" style={{ marginBottom: 12 }}>
      <button type="button" className="btn sm" disabled={!src || m.isPending} onClick={() => m.mutate(undefined)}>{m.isPending ? 'Thinking…' : '✨ Suggest alt text'}</button>
      <ErrorBanner error={m.error} />
      {m.data ? <div className="row"><span className="small grow">“{m.data.alt}”</span><button type="button" className="btn sm primary" onClick={() => { onApply(m.data!.alt); m.reset(); }}>Use</button></div> : null}
    </div>
  );
}
