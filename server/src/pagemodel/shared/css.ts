/**
 * Base stylesheet of every published page AND of the builder canvas (the canvas loads this exact string, so editing is WYSIWYG).
 * Written with :where() so its specificity is zero: any class or id rule the author creates in the Style Manager wins.
 * Text colours are inherited from the surrounding section (`fn-dark` flips them), never hard-coded per element, so
 * copy is readable on light and dark backgrounds alike (contrast is unit-tested in test/pagemodel.css.test.ts).
 */
export const FN_PAGE_CLASS = 'fn-page';

export const BASE_CSS = `
:root{--fn-accent:#2563eb;--fn-accent-ink:#ffffff;--fn-bg:#ffffff;--fn-text:#0f172a;--fn-muted:#475569;--fn-border:#e2e8f0;--fn-surface:#f1f5f9;--fn-card:#ffffff;--fn-card-ink:#0f172a;--fn-link:#1d4ed8;--fn-radius:12px;--fn-font:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--fn-w:1170px;--fn-gap:24px}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--fn-bg);color:var(--fn-text);font-family:var(--fn-font);font-size:17px;line-height:1.65;-webkit-font-smoothing:antialiased}
:where(img,video,iframe){max-width:100%}
:where(a){color:var(--fn-link)}
:where(.fn-page) :where(h1,h2,h3,h4,h5,h6){line-height:1.15;letter-spacing:-.02em;margin:0 0 .5em;font-weight:800;color:inherit}
:where(.fn-page) h1{font-size:clamp(2.25rem,5.2vw,3.5rem)}
:where(.fn-page) h2{font-size:clamp(1.75rem,4vw,2.5rem)}
:where(.fn-page) h3{font-size:clamp(1.35rem,2.6vw,1.65rem)}
:where(.fn-page) h4{font-size:1.2rem}
:where(.fn-page) h5{font-size:1.05rem}
:where(.fn-page) h6{font-size:.95rem;text-transform:uppercase;letter-spacing:.06em}
:where(.fn-page) p{margin:0 0 1.1em}
:where(.fn-page) :where(h1,h2,h3,h4,h5,h6,p,ul,ol):last-child{margin-bottom:0}
.fn-skip{position:absolute;left:-999px;top:0;background:#000;color:#fff;padding:8px 12px;z-index:50}.fn-skip:focus{left:8px;top:8px}
:focus-visible{outline:3px solid var(--fn-accent);outline-offset:2px}
:where(.fn-section){position:relative;width:100%;padding:72px 0;background:transparent}
:where(.fn-section.fn-pad-none){padding:0}:where(.fn-section.fn-pad-sm){padding:32px 0}:where(.fn-section.fn-pad-md){padding:56px 0}:where(.fn-section.fn-pad-lg){padding:88px 0}:where(.fn-section.fn-pad-xl){padding:120px 0}
:where(.fn-section)>:where(*){width:100%;max-width:var(--fn-w);margin-left:auto;margin-right:auto;padding-left:24px;padding-right:24px}
:where(.fn-section.fn-w-full){--fn-w:none}:where(.fn-section.fn-w-wide){--fn-w:1170px}:where(.fn-section.fn-w-medium){--fn-w:994px}:where(.fn-section.fn-w-small){--fn-w:652px}
:where(.fn-section.fn-align-center){text-align:center}
:where(.fn-dark){--fn-text:#f8fafc;--fn-muted:#cbd5e1;--fn-border:#334155;--fn-surface:#1e293b;--fn-link:#93c5fd;--fn-card:#1e293b;--fn-card-ink:#f8fafc;background:#0f172a;color:var(--fn-text)}
:where(.fn-accent-bg){--fn-text:#ffffff;--fn-muted:#e0e7ff;--fn-link:#ffffff;--fn-card:#ffffff;--fn-card-ink:#0f172a;background:#1d4ed8;color:var(--fn-text)}
:where(.fn-soft){background:var(--fn-surface)}
:where(.fn-row){display:flex;flex-wrap:wrap;gap:var(--fn-gap);align-items:stretch;margin-bottom:var(--fn-gap)}
:where(.fn-row:last-child){margin-bottom:0}
:where(.fn-row.fn-gap-none){gap:0}:where(.fn-row.fn-gap-sm){--fn-gap:12px}:where(.fn-row.fn-gap-lg){--fn-gap:44px}
:where(.fn-row.fn-valign-center){align-items:center}:where(.fn-row.fn-valign-start){align-items:flex-start}:where(.fn-row.fn-valign-end){align-items:flex-end}
:where(.fn-column){flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:18px}
:where(.fn-column)>:where(*){margin-top:0;margin-bottom:0}
:where(.fn-row.fn-ratio-1-2>.fn-column:nth-child(2),.fn-row.fn-ratio-1-2-1>.fn-column:nth-child(2)){flex-grow:2}
:where(.fn-row.fn-ratio-2-1>.fn-column:first-child){flex-grow:2}
:where(.fn-row.fn-ratio-1-3>.fn-column:nth-child(2)){flex-grow:3}
:where(.fn-row.fn-ratio-3-1>.fn-column:first-child){flex-grow:3}
@media(max-width:640px){.fn-row:not(.fn-keep)>.fn-column{flex:1 1 100%!important;max-width:100%!important}:where(.fn-countdown){gap:8px}:where(.fn-countdown>div){min-width:62px;padding:10px 8px}:where(.fn-countdown strong){font-size:1.6rem}:where(.fn-section.fn-pad-lg){padding:56px 0}:where(.fn-section.fn-pad-xl){padding:72px 0}}
:where(.fn-al-left){text-align:left}:where(.fn-al-center){text-align:center}:where(.fn-al-right){text-align:right}
:where(.fn-column>.fn-btn,.fn-column>.fn-img,.fn-column>.fn-video){align-self:flex-start}
:where(.fn-column>.fn-btn.fn-al-center,.fn-column>.fn-img.fn-al-center,.fn-section.fn-align-center .fn-column>.fn-btn,.fn-section.fn-align-center .fn-column>.fn-img){align-self:center}
:where(.fn-column>.fn-btn.fn-al-right,.fn-column>.fn-img.fn-al-right){align-self:flex-end}
:where(.fn-column>.fn-btn.fn-btn-block){align-self:stretch}
:where(.fn-section.fn-align-center .fn-list-check){display:inline-flex;text-align:left}
:where(.fn-img){display:block;max-width:100%;height:auto;border-radius:var(--fn-radius)}
:where(.fn-btn-row){display:block;margin:6px 0}
:where(.fn-btn){display:inline-flex;align-items:center;justify-content:center;gap:.5em;text-decoration:none;font:inherit;font-weight:700;line-height:1.25;text-align:center;border-radius:var(--fn-radius);padding:.85em 1.6em;border:2px solid var(--fn-accent);background:var(--fn-accent);color:var(--fn-accent-ink);cursor:pointer;transition:transform .15s,box-shadow .15s,filter .15s}
:where(.fn-btn:hover){filter:brightness(.94);box-shadow:0 6px 18px -8px rgba(15,23,42,.45)}
:where(.fn-btn:active){transform:translateY(1px)}
:where(.fn-btn-lg){padding:1.05em 2.1em;font-size:1.1em}:where(.fn-btn-sm){padding:.55em 1.1em;font-size:.9em}:where(.fn-btn-block){display:flex;width:100%}
:where(.fn-btn-secondary){background:#0f172a;border-color:#0f172a;color:#fff}
:where(.fn-dark .fn-btn-secondary){background:#f8fafc;border-color:#f8fafc;color:#0f172a}
:where(.fn-btn-outline){background:transparent;color:inherit;border-color:currentColor}
:where(.fn-btn-ghost){background:transparent;border-color:transparent;color:inherit}
:where(.fn-pill){border-radius:999px}
:where(.fn-video){position:relative;aspect-ratio:16/9;background:#0b1220;border-radius:var(--fn-radius);overflow:hidden;display:block}
:where(.fn-video iframe,.fn-video video){position:absolute;inset:0;width:100%;height:100%;border:0}
:where(.fn-video-placeholder,.fn-video-empty){display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#e2e8f0;font-size:.95rem;text-align:center;padding:16px}
:where(.fn-video-play){width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,.14);border:2px solid rgba(255,255,255,.7);position:relative}
:where(.fn-video-play)::after{content:"";position:absolute;left:25px;top:18px;border-left:18px solid #fff;border-top:12px solid transparent;border-bottom:12px solid transparent}
:where(hr.fn-divider){border:0;border-top:1px solid var(--fn-border);margin:12px 0;width:100%}
:where(.fn-spacer){display:block;width:100%;height:40px}
:where(.fn-list){margin:0;padding-left:1.35em;display:flex;flex-direction:column;gap:.5em}
:where(.fn-list-check){list-style:none;padding:0}:where(.fn-list-check>li){position:relative;padding-left:2em}
:where(.fn-list-check>li)::before{content:"";position:absolute;left:0;top:.28em;width:1.35em;height:1.35em;border-radius:50%;background:var(--fn-accent)}
:where(.fn-list-check>li)::after{content:"";position:absolute;left:.48em;top:.5em;width:.4em;height:.7em;border:solid var(--fn-accent-ink);border-width:0 2px 2px 0;transform:rotate(45deg)}
:where(.fn-faq){display:flex;flex-direction:column;gap:12px;width:100%}
:where(.fn-faq-item){border:1px solid var(--fn-border);border-radius:var(--fn-radius);padding:0 20px;background:var(--fn-card);color:var(--fn-card-ink)}
:where(.fn-faq-item>summary){cursor:pointer;font-weight:700;padding:18px 0;list-style:none;display:flex;justify-content:space-between;gap:16px;align-items:center}
:where(.fn-faq-item>summary)::-webkit-details-marker{display:none}
:where(.fn-faq-item>summary)::after{content:"+";font-size:1.4em;line-height:1;font-weight:500}
:where(.fn-faq-item[open]>summary)::after{content:"\\2212"}
:where(.fn-faq-item>div){padding:0 0 18px;margin:0}
:where(.fn-tabs){width:100%}
:where(.fn-tab-nav){display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--fn-border);margin-bottom:20px}
:where(.fn-tab-btn){font:inherit;font-weight:600;background:transparent;border:0;border-bottom:3px solid transparent;color:var(--fn-muted);padding:12px 18px;cursor:pointer;margin-bottom:-1px}
:where(.fn-tab-btn[aria-selected=true],.fn-tab-btn.fn-active){color:var(--fn-text);border-bottom-color:var(--fn-accent)}
:where(.fn-tab-panel[hidden]){display:none}
:where(.fn-card){background:var(--fn-card);color:var(--fn-card-ink);border:1px solid var(--fn-border);border-radius:calc(var(--fn-radius) + 4px);padding:28px;box-shadow:0 1px 2px rgba(15,23,42,.05),0 8px 24px -12px rgba(15,23,42,.18);display:flex;flex-direction:column;gap:14px}
:where(.fn-card.fn-featured){border:2px solid var(--fn-accent);box-shadow:0 18px 40px -18px rgba(37,99,235,.45)}
:where(.fn-card) :where(p){color:inherit}
:where(.fn-quote){font-size:1.1rem;font-style:normal}
:where(.fn-person){display:flex;align-items:center;gap:12px;font-weight:600}
:where(.fn-person img){width:44px;height:44px;border-radius:50%;object-fit:cover}
:where(.fn-price-tag){font-size:2.75rem;font-weight:800;letter-spacing:-.03em;line-height:1}
:where(.fn-self-center){align-self:center}
:where(.fn-muted){color:var(--fn-muted)}
:where(.fn-eyebrow){font-size:.8rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--fn-link)}
:where(.fn-dark .fn-eyebrow){color:#fde68a}
:where(.fn-badge){display:inline-block;font-size:.78rem;font-weight:700;padding:.25em .8em;border-radius:999px;background:var(--fn-accent);color:var(--fn-accent-ink)}
:where(.fn-navbar){display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;padding:16px 24px;background:var(--fn-bg);color:var(--fn-text);border-bottom:1px solid var(--fn-border)}
:where(.fn-navbar .fn-brand){font-weight:800;font-size:1.15rem;text-decoration:none;color:inherit}
:where(.fn-nav-links){display:flex;flex-wrap:wrap;gap:20px;align-items:center}
:where(.fn-nav-links a){text-decoration:none;color:inherit;font-weight:500}
:where(.fn-footer){padding:40px 24px;background:#0f172a;color:#cbd5e1;font-size:.92rem;text-align:center}
:where(.fn-footer a){color:#e2e8f0}
:where(.fn-footer .fn-nav-links){justify-content:center;margin-bottom:14px}
:where(.fn-popup){display:none;position:fixed;inset:0;z-index:100;align-items:center;justify-content:center;padding:20px;background:rgba(15,23,42,.62)}
:where(.fn-popup.fn-open){display:flex}
:where(.fn-popup-dialog){position:relative;background:var(--fn-card);color:var(--fn-card-ink);border-radius:calc(var(--fn-radius) + 4px);padding:32px;max-width:520px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 30px 80px -20px rgba(0,0,0,.5)}
:where(.fn-popup-close){position:absolute;right:12px;top:12px;width:36px;height:36px;border-radius:50%;border:0;background:transparent;color:inherit;font-size:1.5rem;line-height:1;cursor:pointer}
:where(.fn-rv){display:flex;flex-direction:column;gap:14px}
:where(.fn-rv-list){list-style:none;margin:0;padding:0;display:grid;gap:16px}
:where(.fn-rv-grid){grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
:where(.fn-rv-stack){grid-template-columns:1fr}
:where(.fn-rv-carousel){display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:16px;padding-bottom:8px}
:where(.fn-rv-carousel>.fn-rv-item){flex:0 0 min(320px,85%);scroll-snap-align:start}
:where(.fn-rv-item){background:var(--fn-card);color:var(--fn-card-ink);border:1px solid var(--fn-border);border-radius:var(--fn-radius);padding:16px;display:flex;flex-direction:column;gap:8px}
:where(.fn-rv-author){display:flex;align-items:center;gap:10px;font-weight:700;color:inherit;text-decoration:none}
:where(.fn-rv-avatar){width:40px;height:40px;border-radius:50%;object-fit:cover}
:where(.fn-rv-meta){display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:.85rem}
:where(.fn-rv-stars){color:#b45309;letter-spacing:.08em;white-space:nowrap}
:where(.fn-rv-when){color:var(--fn-muted)}
:where(.fn-dark .fn-rv-stars){color:#fbbf24}
:where(.fn-rv-text){margin:0;font-size:.97rem;line-height:1.55;overflow-wrap:anywhere}
:where(.fn-rv-summary){display:flex;align-items:center;gap:8px;flex-wrap:wrap}
:where(.fn-rv-badge){display:inline-flex;align-items:center;gap:8px;background:var(--fn-card);color:var(--fn-card-ink);border:1px solid var(--fn-border);border-radius:999px;padding:8px 16px}
:where(.fn-rv-attr){margin:0;font-size:.82rem;color:var(--fn-muted)}
:where(.fn-rc){display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
:where(.fn-rc-prompt){margin:0}
@keyframes fnrc{to{opacity:1;visibility:visible}}
:where(.fn-rc-wait){visibility:hidden;opacity:0;animation:fnrc .4s forwards}
.fn-rc-d5{animation-delay:5s}.fn-rc-d10{animation-delay:10s}.fn-rc-d15{animation-delay:15s}.fn-rc-d30{animation-delay:30s}.fn-rc-d60{animation-delay:60s}.fn-rc-d90{animation-delay:90s}.fn-rc-d120{animation-delay:120s}
@media(prefers-reduced-motion:reduce){:where(.fn-rc-wait){animation-duration:.01s}}
:where(.fn-countdown){display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
:where(.fn-countdown>div){background:#0f172a;color:#fff;border-radius:var(--fn-radius);padding:14px 18px;min-width:84px;text-align:center;border:1px solid rgba(255,255,255,.12)}
:where(.fn-countdown strong){display:block;font-size:2rem;line-height:1.1;font-variant-numeric:tabular-nums}
:where(.fn-countdown small){color:#cbd5e1;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em}
:where(.fn-cd-label,.fn-cd-msg){text-align:center;font-weight:700;margin-bottom:10px}
:where(.fn-progress){height:14px;border-radius:999px;background:var(--fn-border);overflow:hidden;width:100%}
:where(.fn-progress-bar){height:100%;background:var(--fn-accent);border-radius:999px}
:where(.fn-progress-label){display:flex;justify-content:space-between;font-weight:600;font-size:.9rem;margin-bottom:6px}
:where(.fn-form,.fn-offer){border:1px solid var(--fn-border);border-radius:calc(var(--fn-radius) + 2px);padding:26px;background:var(--fn-card);color:var(--fn-card-ink);box-shadow:0 1px 2px rgba(15,23,42,.05),0 12px 32px -16px rgba(15,23,42,.25);text-align:left}
:where(.fn-field){margin:0 0 14px}
:where(.fn-field label){display:block;font-weight:600;margin-bottom:6px;font-size:.92rem}
:where(.fn-field input[type=text],.fn-field input[type=email],.fn-field input[type=tel],.fn-field textarea,.fn-field select){width:100%;padding:12px 14px;border:1px solid #94a3b8;border-radius:10px;font:inherit;background:#fff;color:#0f172a}
:where(.fn-field input:focus,.fn-field textarea:focus,.fn-field select:focus){border-color:var(--fn-accent);outline:3px solid rgba(37,99,235,.28);outline-offset:0}
:where(.fn-check){display:flex!important;gap:10px;align-items:flex-start;font-weight:400!important}
:where(.fn-req){color:#b91c1c;margin-left:3px}
.fn-hp{position:absolute!important;left:-5000px!important;width:1px;height:1px;overflow:hidden}
:where(.fn-status){margin:12px 0 0;font-weight:600;min-height:1.2em}
:where(.fn-status.fn-error){color:#b91c1c}:where(.fn-status.fn-ok){color:#047857}
:where(.fn-offer h3){margin-bottom:4px}
:where(.fn-price){font-size:2rem;font-weight:800;margin:0 0 10px}
:where(.fn-note){font-size:.82rem;color:#475569;margin:12px 0 0}
:where(.fn-bump){display:flex;gap:12px;align-items:flex-start;border:2px dashed var(--fn-accent);border-radius:var(--fn-radius);padding:16px;background:var(--fn-card);color:var(--fn-card-ink);cursor:pointer}
:where(.fn-code){overflow-wrap:anywhere}
.show-none{display:none!important}
@media(max-width:640px){.show-desktop-only{display:none!important}}
@media(min-width:641px){.show-mobile-only{display:none!important}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`.replace(/\n/g, '');

/** Fonts offered in the page font picker; keyed by label, value is the CSS font-family stack (no remote font is loaded for these). */
export const FONT_STACKS: Record<string, string> = {
  Inter: 'Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  System: 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif',
  Serif: 'Georgia,"Times New Roman",Times,serif',
  Mono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  Rounded: '"Nunito","Trebuchet MS",ui-rounded,system-ui,sans-serif',
};
