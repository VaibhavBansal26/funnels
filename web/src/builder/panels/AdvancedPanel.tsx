import { Eye, EyeOff, Monitor, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cleanDeclarations, safeCssValue, safeProperty } from '@pagemodel';
import { Button, Textarea } from '../../ui';
import { readStyle, writeStyle } from '../styleApi';
import { SELECTION_EVENTS, useBuilder, useEditorEvents } from '../useEditor';
import { inputCls, Row, Section, Segmented } from './kit';

const VIS = [
  { value: '', label: <Eye />, title: 'Visible on all devices' },
  { value: 'show-desktop-only', label: <Monitor />, title: 'Desktop only (hidden on phones)' },
  { value: 'show-mobile-only', label: <Smartphone />, title: 'Phones only' },
  { value: 'show-none', label: <EyeOff />, title: 'Hidden everywhere' },
] as const;

/** Identity, extra classes and attributes, visibility per device, and raw declarations for the current style target (filtered like everything else). */
export function AdvancedPanel() {
  const { editor } = useBuilder();
  useEditorEvents(editor, SELECTION_EVENTS);
  const c = editor.getSelected();
  const style = readStyle(editor);
  const asText = Object.entries(style).map(([k, v]) => `${k}: ${v};`).join('\n');
  const [text, setText] = useState(asText);
  const [problems, setProblems] = useState<string[]>([]);
  useEffect(() => { setText(asText); setProblems([]); }, [asText, c]);
  if (!c) return null;
  const attrs = c.getAttributes() as Record<string, string>;
  const custom = c.getClasses().filter((k) => !/^(fn-|show-)/.test(k));
  const vis = c.getClasses().find((k) => /^show-(none|desktop-only|mobile-only)$/.test(k)) ?? '';
  const setVis = (v: string) => { for (const k of ['show-none', 'show-desktop-only', 'show-mobile-only']) c.removeClass(k); if (v) c.addClass(v); };
  const dataAttrs = Object.entries(attrs).filter(([k]) => /^(data-[a-z][a-z0-9-]*|aria-label|title)$/.test(k));
  const [newKey, setNewKey] = useState('');

  const apply = () => {
    const bad: string[] = [];
    const next: Record<string, string> = {};
    for (const line of text.split(/;\s*\n|;\s*$|\n/)) {
      const m = /^\s*([a-z-]+|--[a-z0-9-]+)\s*:\s*(.+?)\s*;?\s*$/i.exec(line);
      if (!line.trim()) continue;
      if (!m) { bad.push(`Cannot read “${line.trim()}”`); continue; }
      if (!safeProperty(m[1]!)) { bad.push(`“${m[1]}” is not an allowed property`); continue; }
      if (safeCssValue(m[2]) === null) { bad.push(`“${m[1]}: ${m[2]}” has a value that is not allowed`); continue; }
      next[m[1]!.toLowerCase()] = m[2]!;
    }
    setProblems(bad);
    for (const k of Object.keys(style)) if (!(k in next)) writeStyle(editor, k, '');
    for (const [k, v] of Object.entries(cleanDeclarations(next))) writeStyle(editor, k, v);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" role="region" aria-label="Advanced">
      <Section title="Visibility" id="visibility">
        <Segmented<string> label="Visibility by device" value={vis} onChange={setVis} options={VIS.map((o) => ({ ...o }))} />
        <p className="text-[0.72rem] text-muted">Hidden elements stay visible (dimmed) while editing so you can still select them.</p>
      </Section>
      <Section title="Identity" id="identity">
        <Row label="ID / anchor" htmlFor="adv-id"><input id="adv-id" className={inputCls} value={attrs.id ?? ''} placeholder="auto" onChange={(e) => /^[A-Za-z]?[A-Za-z0-9_-]{0,39}$/.test(e.target.value) && c.addAttributes({ id: e.target.value })} /></Row>
        <Row label="Classes" htmlFor="adv-classes" hint="Space separated. Structural classes (fn-*) are managed for you."><input id="adv-classes" className={inputCls} value={custom.join(' ')} onChange={(e) => { const keep = c.getClasses().filter((k) => /^(fn-|show-)/.test(k)); const mine = e.target.value.split(/\s+/).filter((k) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(k)); c.setClass([...keep, ...mine]); }} /></Row>
      </Section>
      <Section title="Attributes" id="attributes" defaultOpen={false}>
        {dataAttrs.map(([k, v]) => (
          <Row key={k} label={k}><div className="flex gap-1.5"><input aria-label={k} className={inputCls} value={v} onChange={(e) => c.addAttributes({ [k]: e.target.value })} /><Button size="xs" variant="ghost" aria-label={`Remove ${k}`} onClick={() => c.removeAttributes(k)}>×</Button></div></Row>
        ))}
        <div className="flex gap-1.5">
          <input aria-label="New attribute name" className={inputCls} placeholder="data-… , aria-label, title" value={newKey} onChange={(e) => setNewKey(e.target.value.toLowerCase())} />
          <Button size="sm" disabled={!/^(data-[a-z][a-z0-9-]*|aria-label|title)$/.test(newKey) || newKey.startsWith('data-gjs') || newKey.startsWith('data-fn')} onClick={() => { c.addAttributes({ [newKey]: '' }); setNewKey(''); }}>Add</Button>
        </div>
        <p className="text-[0.72rem] text-muted">Event handlers, styles and URLs cannot be added as attributes: the server removes them.</p>
      </Section>
      <Section title="CSS for this element" id="css" defaultOpen={false}>
        <Textarea aria-label="CSS declarations" spellCheck={false} className="min-h-32 font-mono text-[0.78rem]" value={text} onChange={(e) => setText(e.target.value)} placeholder={'color: #0f172a;\nmargin-top: 24px;'} />
        <div className="flex items-center gap-2"><Button size="sm" variant="primary" onClick={apply}>Apply</Button><span className="text-[0.72rem] text-muted">Applies to the current style target, device and state.</span></div>
        {problems.length ? <ul role="alert" className="m-0 list-disc rounded-md bg-danger-soft px-5 py-2 text-[0.78rem] text-danger">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      </Section>
    </div>
  );
}
