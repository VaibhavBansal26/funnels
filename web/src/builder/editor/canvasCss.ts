import { BASE_CSS } from '@pagemodel';

/**
 * The document inside the canvas iframe. It loads the published page stylesheet verbatim (WYSIWYG) plus a few editor-only rules, and gets a
 * Content-Security-Policy that forbids every script (inline handlers, javascript: URLs, <script>), plugins, frames, base tags and form posts.
 * The editor itself is not affected (its code runs in the parent window and only manipulates this document), so even page content that somehow
 * contained markup could not execute here. Page data is additionally rebuilt from an allow-list before it is loaded (see load.ts).
 */
const CSP = "default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; img-src https: http: data: blob: 'self'; media-src https: data: blob: 'self'; style-src 'unsafe-inline' https:; font-src https: data:";

export const EDITOR_ONLY_CSS = `
body{min-height:100vh}
html{scroll-behavior:auto}
/* empty containers explain themselves */
.fn-column:empty{min-height:72px;border:1.5px dashed rgba(99,102,241,.55);border-radius:10px;display:flex;align-items:center;justify-content:center}
.fn-column:empty::before{content:"Drop an element here";color:#6366f1;font:600 13px/1.2 Inter,system-ui,sans-serif}
.fn-section:empty{min-height:96px;border:1.5px dashed rgba(0,152,104,.6);display:flex;align-items:center;justify-content:center}
.fn-section:empty::before{content:"Empty section: drop a row here";color:#047857;font:600 13px/1.2 Inter,system-ui,sans-serif}
.fn-row:empty{min-height:72px;border:1.5px dashed rgba(16,107,244,.6)}
.fn-box:empty,.fn-tab-panel:empty,.fn-popup-dialog:empty{min-height:56px;border:1.5px dashed rgba(99,102,241,.45)}
/* the canvas edits, it does not interact */
a,button{cursor:default}
.fn-form *,.fn-offer *,.fn-bump *,.fn-countdown *{pointer-events:none}
.fn-hp{display:none!important}
.fn-popup{display:block!important;position:relative!important;inset:auto!important;background:transparent!important;padding:12px!important;z-index:auto!important;border:1.5px dashed rgba(217,119,6,.7);border-radius:12px;margin:12px 24px}
.fn-popup::before{content:"Popup (hidden on the published page until a button opens it)";display:block;color:#b45309;font:600 12px/1.2 Inter,system-ui,sans-serif;margin:0 0 8px 4px}
.fn-popup-dialog{margin:0 auto}
.fn-tab-panel[hidden]{display:none!important}
.fn-code-preview{margin:0;padding:12px;border-radius:10px;background:#0f172a;color:#cbd5e1;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;overflow:hidden;max-height:180px}
.show-none,.show-desktop-only,.show-mobile-only{display:block!important;opacity:.45;outline:1px dashed #94a3b8}
/* selection colours keep the legacy builder's coding: sections green, rows and columns blue, elements orange */
.gjs-selected{outline:2px solid #f67c24!important;outline-offset:-2px}
.fn-section.gjs-selected{outline-color:#009868!important}
.fn-row.gjs-selected,.fn-column.gjs-selected{outline-color:#106bf4!important}
[data-gjs-type=wrapper].gjs-selected{outline-color:transparent!important}
.gjs-dashed .fn-section{outline:1px dashed rgba(0,152,104,.35);outline-offset:-1px}
.gjs-dashed .fn-row{outline:1px dashed rgba(16,107,244,.3);outline-offset:-1px}
.gjs-dashed .fn-column{outline:1px dashed rgba(16,107,244,.3);outline-offset:-1px}
*::-webkit-scrollbar{width:10px;height:10px}*::-webkit-scrollbar-thumb{background:rgba(100,116,139,.45);border-radius:8px}
`;

/** Stylesheet of the canvas: the published page CSS plus the editor-only rules (GrapesJS `canvasCss`). */
export const CANVAS_CSS = `${BASE_CSS}${EDITOR_ONLY_CSS}`;

/** Added to the frame's head as soon as it exists, before any page content is rendered into the body. */
export function installFramePolicy(doc: Document): void {
  const meta = doc.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = CSP;
  doc.head.prepend(meta);
}
