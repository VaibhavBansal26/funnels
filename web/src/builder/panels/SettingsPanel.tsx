import { Sparkles } from 'lucide-react';
import { Button } from '../../ui';
import { TYPE_LABEL } from '../editor/rules';
import { SELECTION_EVENTS, useBuilder, useEditorEvents } from '../useEditor';
import { Section } from './kit';
import { BasicTrait, TRAIT_EDITORS } from './traits';

const TEXTY = new Set(['fn-heading', 'fn-text', 'fn-button', 'text', 'link']);

/** Element-specific settings: the traits the component type declares, each with its own editor. */
export function SettingsPanel() {
  const { editor } = useBuilder();
  useEditorEvents(editor, SELECTION_EVENTS);
  const c = editor.getSelected();
  if (!c) return null;
  const type = String(c.get('type') ?? 'default');
  const traits = c.getTraits();
  const multi = editor.getSelectedAll().length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" role="region" aria-label="Settings">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{c.getName()}</h3>
          <p className="text-[0.75rem] text-muted">{TYPE_LABEL[type] && TYPE_LABEL[type] !== c.getName() ? TYPE_LABEL[type] : 'Element'}{multi > 1 ? ` · settings apply to the first of ${multi} selected` : ''}</p>
        </div>
        {TEXTY.has(type) && type !== 'fn-tab-btn' ? <Button size="sm" variant="soft" onClick={() => editor.runCommand('fn:ai-rewrite')}><Sparkles /> Rewrite</Button> : null}
      </div>
      {traits.length === 0 ? <p className="p-4 text-[0.82rem] text-muted">This element has no settings. Use the Style tab to change how it looks.</p> : null}
      <div className="flex flex-col gap-3.5 p-3">
        {traits.map((t) => {
          const Custom = TRAIT_EDITORS[String(t.get('type'))];
          const props = { editor, component: c, trait: t };
          return Custom ? (
            <Section key={`${String(t.get("type"))}:${t.getName()}`} title={t.getLabel()} id={String(t.get('type'))}>{Custom(props)}</Section>
          ) : (
            <BasicTrait key={`${String(t.get("type"))}:${t.getName()}`} {...props} />
          );
        })}
      </div>
    </div>
  );
}
