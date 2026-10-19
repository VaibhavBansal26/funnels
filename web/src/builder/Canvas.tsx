import { renderPage, type PageDocument } from '@blocks';
import { useEffect, useMemo, useRef } from 'react';
import { DEVICE_WIDTH, type Device } from '../components/PreviewFrame';

const EDITOR_CSS = '<style>[data-bid]{cursor:pointer}[data-bid]:hover{outline:1px dashed rgba(37,99,235,.7);outline-offset:2px}.fn-sel{outline:2px solid #2563eb!important;outline-offset:2px}</style>';
// Runs inside the sandboxed canvas (scripts allowed, no same-origin access). It only reports clicks/scroll and highlights the selected block.
const EDITOR_JS = `<script>(function(){var sel=null;function mark(){var a=document.querySelectorAll('[data-bid]');for(var i=0;i<a.length;i++){a[i].classList.toggle('fn-sel',a[i].getAttribute('data-bid')===sel)}}
document.addEventListener('click',function(e){e.preventDefault();var el=e.target&&e.target.closest?e.target.closest('[data-bid]'):null;parent.postMessage({fnEditor:true,type:'select',id:el?el.getAttribute('data-bid'):null},'*')},true);
document.addEventListener('submit',function(e){e.preventDefault()},true);
window.addEventListener('message',function(e){var d=e.data;if(!d||!d.fnEditor)return;if(d.type==='select'){sel=d.id;mark()}if(d.type==='scroll')window.scrollTo(0,d.y)});
var t=0;window.addEventListener('scroll',function(){clearTimeout(t);t=setTimeout(function(){parent.postMessage({fnEditor:true,type:'scroll',y:window.scrollY},'*')},100)});
parent.postMessage({fnEditor:true,type:'ready'},'*')})();</script>`;

export function buildCanvasHtml(doc: PageDocument, opts: { funnelId: string; stepId: string; stepName: string; steps: { id: string }[] }): string {
  const html = renderPage(doc, { funnelId: opts.funnelId, stepId: opts.stepId, stepName: opts.stepName, steps: opts.steps.map((s) => ({ id: s.id, href: '#' })), mode: 'builder' });
  return html.replace('</head>', `${EDITOR_CSS}</head>`).replace('</body>', `${EDITOR_JS}</body>`);
}

/** Live preview of the document in a sandboxed iframe. Clicking a block in the canvas selects it in the editor. */
export function Canvas({ doc, funnelId, stepId, stepName, steps, device, selectedId, onSelect }: { doc: PageDocument; funnelId: string; stepId: string; stepName: string; steps: { id: string }[]; device: Device; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const scroll = useRef(0);
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const html = useMemo(() => buildCanvasHtml(doc, { funnelId, stepId, stepName, steps }), [doc, funnelId, stepId, stepName, steps]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data?.fnEditor) return;
      const win = frame.current?.contentWindow;
      if (e.data.type === 'select') onSelect(e.data.id ?? null);
      else if (e.data.type === 'scroll') scroll.current = Number(e.data.y) || 0;
      else if (e.data.type === 'ready') {
        win?.postMessage({ fnEditor: true, type: 'scroll', y: scroll.current }, '*');
        win?.postMessage({ fnEditor: true, type: 'select', id: selected.current }, '*');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSelect]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ fnEditor: true, type: 'select', id: selectedId }, '*');
  }, [selectedId]);

  return (
    <div className="canvas">
      <iframe ref={frame} title={`Live preview of ${stepName}`} sandbox="allow-scripts" srcDoc={html} style={{ width: DEVICE_WIDTH[device] }} />
    </div>
  );
}
