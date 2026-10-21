import { Blocks, FileStack, Image as ImageIcon, Layers, Sparkles } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui';
import { AiPanel } from './AiPanel';
import { AssetsPanel } from './AssetsPanel';
import { BlocksPanel } from './BlocksPanel';
import { LayersPanel } from './LayersPanel';
import { PagesPanel } from './PagesPanel';

export type LeftTab = 'blocks' | 'layers' | 'pages' | 'assets' | 'ai';

/** Left rail: Blocks (searchable, categorised, draggable), Layers (tree with visibility, lock and drag), Pages (steps of the funnel) and Assets (uploaded images). */
export function LeftRail({ tab, onTab }: { tab: LeftTab; onTab: (t: LeftTab) => void }) {
  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as LeftTab)} className="flex min-h-0 flex-1 flex-col">
      <TabsList className="shrink-0 px-1.5" aria-label="Builder sections">
        <TabsTrigger value="blocks" aria-label="Blocks" className="group"><Blocks /><span className="hidden group-data-[state=active]:inline">Blocks</span></TabsTrigger>
        <TabsTrigger value="layers" aria-label="Layers" className="group"><Layers /><span className="hidden group-data-[state=active]:inline">Layers</span></TabsTrigger>
        <TabsTrigger value="pages" aria-label="Pages" className="group"><FileStack /><span className="hidden group-data-[state=active]:inline">Pages</span></TabsTrigger>
        <TabsTrigger value="assets" aria-label="Images" className="group"><ImageIcon /><span className="hidden group-data-[state=active]:inline">Images</span></TabsTrigger>
        <TabsTrigger value="ai" aria-label="AI assistant" className="group"><Sparkles /><span className="hidden group-data-[state=active]:inline">AI</span></TabsTrigger>
      </TabsList>
      <TabsContent value="blocks" className="flex min-h-0 flex-1 flex-col"><BlocksPanel /></TabsContent>
      <TabsContent value="layers" className="flex min-h-0 flex-1 flex-col"><LayersPanel /></TabsContent>
      <TabsContent value="pages" className="flex min-h-0 flex-1 flex-col"><PagesPanel /></TabsContent>
      <TabsContent value="assets" className="flex min-h-0 flex-1 flex-col"><AssetsPanel /></TabsContent>
      <TabsContent value="ai" className="flex min-h-0 flex-1 flex-col"><AiPanel /></TabsContent>
    </Tabs>
  );
}
