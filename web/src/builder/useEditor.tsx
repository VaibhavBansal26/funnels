import type { Editor } from 'grapesjs';
import { createContext, useContext, useEffect, useReducer } from 'react';
import type { BuilderEnv } from './editor/env';

export interface BuilderCtx {
  editor: Editor;
  env: BuilderEnv;
  /** Ask the host (BuilderApp) to open a dialog or run a flow that needs React UI. */
  ui: BuilderUi;
}

export interface BuilderUi {
  openAssets(pick?: (url: string) => void): void;
  openShortcuts(): void;
  openPageSettings(): void;
  openHistory(): void;
  saveBlock(): void;
  toast(message: string, kind?: 'info' | 'ok' | 'error'): void;
  save(backup: boolean): Promise<unknown>;
  goToStep(id: string): void;
}

const Ctx = createContext<BuilderCtx | null>(null);
export const BuilderProvider = Ctx.Provider;
export function useBuilder(): BuilderCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useBuilder outside BuilderProvider');
  return c;
}

/**
 * Re-renders the calling component when any of the editor events fire (coalesced to one render per animation frame) and returns the editor.
 * GrapesJS state is mutable and event driven, so panels read it during render and subscribe to the events that can change what they show.
 */
export function useEditorEvents(editor: Editor | null, events: string): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    const handler = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        bump();
      });
    };
    editor.on(events, handler);
    return () => {
      editor.off(events, handler);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editor, events]);
}

export const SELECTION_EVENTS = 'component:selected component:deselected component:update component:styleUpdate style:target style:property:update selector component:toggled';
export const TREE_EVENTS = 'component:add component:remove component:update:name component:update:locked layer component:mount component:selected component:deselected undo redo component:toggled';
