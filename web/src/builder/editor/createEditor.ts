// Adapted from the legacy builder (see docs/PROVENANCE.md): getEditorConfig (canvas, devices, undo manager, layer / style / selector managers rendered by the
// host app), the Desktop / Mobile device list (plus Tablet), and the editor-only outline colours (section green, row blue, element orange).
import grapesjs, { type Editor } from 'grapesjs';
import 'grapesjs/dist/css/grapes.min.css';
import { CANVAS_CSS, installFramePolicy } from './canvasCss';
import { installCommands, installRte, installToolbar } from './commands';
import { setEnv, type BuilderEnv } from './env';
import { installNormalizer, setWrapperRules } from './normalize';
import { registerBlocks } from './blocks';
import { registerTypes } from './types';

export const DEVICES = [
  { id: 'desktop', name: 'Desktop', width: '', widthMedia: '' },
  { id: 'tablet', name: 'Tablet', width: '768px', widthMedia: '992px' },
  { id: 'mobile', name: 'Mobile', width: '390px', widthMedia: '480px' },
] as const;
export type DeviceId = (typeof DEVICES)[number]['id'];

export interface FnEditor extends Editor {
  /** Removes the listeners installed by createEditor (call before destroy). */
  fnDispose?: () => void;
}

/** Creates the GrapesJS editor with every piece of its default chrome switched off: the host app renders blocks, layers, styles, traits and assets itself. */
export function createEditor(container: HTMLElement, env: BuilderEnv): FnEditor {
  const editor = grapesjs.init({
    container,
    height: '100%',
    width: 'auto',
    fromElement: false,
    storageManager: false,
    noticeOnUnload: false,
    avoidInlineStyle: true,
    undoManager: { trackSelection: false, maximumStackLength: 200 },
    panels: { defaults: [] },
    blockManager: { custom: true },
    layerManager: { custom: true },
    styleManager: { custom: true },
    traitManager: { custom: true },
    selectorManager: { custom: true, componentFirst: true },
    assetManager: { custom: true },
    richTextEditor: { adjustToolbar: true },
    deviceManager: { devices: DEVICES.map((d) => ({ id: d.id, name: d.name, width: d.width, widthMedia: d.widthMedia })) },
    canvas: {
      frameStyle: '',
      customBadgeLabel: (c) => c.getName(),
      allowExternalDrop: false,
      notTextable: ['fn-form', 'fn-checkout', 'fn-video', 'fn-countdown', 'fn-progress', 'fn-code'] as never,
    },
    parser: { optionsHtml: { allowScripts: false, allowUnsafeAttr: false, allowUnsafeAttrValue: false } },
    protectedCss: '',
    canvasCss: CANVAS_CSS,
    showOffsets: true,
    multipleSelection: true,
    keymaps: { defaults: {} },
  }) as FnEditor;
  setEnv(editor, env);
  registerTypes(editor);
  registerBlocks(editor, { canScripts: env.canScripts });
  installCommands(editor);
  installRte(editor);
  const offToolbar = installToolbar(editor);
  const offNormalizer = installNormalizer(editor);
  // Structural classes are not styling targets: styling a section styles THAT section, never every section.
  const lock = (sel: { getName(): string; set(p: Record<string, unknown>): void }) => /^(fn-|show-)/.test(sel.getName()) && sel.set({ private: true, protected: true });
  editor.on('selector:add', lock as never);
  editor.on('canvas:frame:load:head', ({ el }: { el: HTMLIFrameElement }) => el.contentDocument && installFramePolicy(el.contentDocument));
  // The page root is the canvas <body>: it carries the page class and the id its style rules (page colours, font) are written against.
  editor.on('canvas:frame:load:body', ({ el }: { el: HTMLIFrameElement }) => {
    const body = el.contentDocument?.body;
    if (body) {
      body.id = 'fnroot';
      body.classList.add('fn-page');
    }
  });
  editor.on('load', () => setWrapperRules(editor));
  editor.fnDispose = () => {
    offToolbar();
    offNormalizer();
  };
  return editor;
}
