import { MousePointerClick, Palette, SlidersHorizontal, Wrench } from 'lucide-react';
import { useState } from 'react';
import { ColorPicker, Select, Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui';
import { applyPageLook, readPageLook } from '../editor/pageLook';
import { FONT_STACKS } from '@pagemodel';
import { SELECTION_EVENTS, useBuilder, useEditorEvents } from '../useEditor';
import { AdvancedPanel } from './AdvancedPanel';
import { Row, Section, PanelEmpty } from './kit';
import { SettingsPanel } from './SettingsPanel';
import { StylePanel } from './StylePanel';

function PageLook() {
  const { editor } = useBuilder();
  useEditorEvents(editor, 'update style:target');
  const look = readPageLook(editor);
  return (
    <Section title="Page look" id="pagelook">
      <Row label="Accent colour"><ColorPicker size="sm" label="Accent colour" value={look.accent} onChange={(accent) => applyPageLook(editor, { accent })} /></Row>
      <Row label="Background"><ColorPicker size="sm" label="Page background" value={look.background} onChange={(background) => applyPageLook(editor, { background })} /></Row>
      <Row label="Font"><Select size="sm" aria-label="Page font" value={look.font} options={[{ value: '', label: 'Inter (default)' }, ...Object.keys(FONT_STACKS).map((k) => ({ value: k, label: k }))]} onValueChange={(font) => applyPageLook(editor, { font })} /></Row>
    </Section>
  );
}

/** Right-hand panel: Style, Settings and Advanced for the selected element; page look when nothing is selected. */
export function Inspector() {
  const { editor } = useBuilder();
  useEditorEvents(editor, SELECTION_EVENTS);
  const [tab, setTab] = useState('style');
  const selected = editor.getSelected();
  if (!selected) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PanelEmpty icon={<MousePointerClick />} title="Select an element">Click anything on the page to style it and change its settings. Press <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-[0.7rem]">?</kbd> for keyboard shortcuts.</PanelEmpty>
        <PageLook />
      </div>
    );
  }
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
      <TabsList className="shrink-0 px-2" aria-label="Inspector">
        <TabsTrigger value="style"><Palette /> Style</TabsTrigger>
        <TabsTrigger value="settings"><SlidersHorizontal /> Settings</TabsTrigger>
        <TabsTrigger value="advanced"><Wrench /> Advanced</TabsTrigger>
      </TabsList>
      <TabsContent value="style" className="flex min-h-0 flex-1 flex-col"><StylePanel /></TabsContent>
      <TabsContent value="settings" className="flex min-h-0 flex-1 flex-col"><SettingsPanel /></TabsContent>
      <TabsContent value="advanced" className="flex min-h-0 flex-1 flex-col"><AdvancedPanel /></TabsContent>
    </Tabs>
  );
}
