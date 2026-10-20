/**
 * The tracking beacon served at /beacon.js. Plain ES5, no dependencies, injected into every page by the renderer.
 * - page view via sendBeacon (visitor id cookie, UTM cookies, unique-visit hint)
 * - progressive enhancement of rendered forms, checkouts and one-click upsells (JSON POST, success actions)
 * - relays opt-in postMessage events from embedded third-party widgets
 * - reports the visitor's marketing touch (UTM parameters, click ids, external referrer) and browser ids (_fbp, _fbc, _ttp, _ga) to /api/public/attribution, ids only when consent allows
 * - announces conversions to the pixel runtime (fn:lead, fn:purchase) with the event ids the server uses for its own Conversions API events
 * In preview mode (data-preview="1") no page view is sent and submissions are flagged so nothing is recorded.
 */
export const BEACON_JS = `(function(){
var s=document.currentScript||document.querySelector('script[data-funnel]');if(!s)return;
var funnel=s.getAttribute('data-funnel'),step=s.getAttribute('data-step'),api=s.getAttribute('data-api')||'',preview=s.getAttribute('data-preview')==='1';
function cookie(n){var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?decodeURIComponent(m[1]):null}
function setCookie(n,v){document.cookie=n+'='+encodeURIComponent(v)+'; path=/; SameSite=Lax'}
function rid(){var a=new Uint8Array(12),c=window.crypto||window.msCrypto,o='';if(c&&c.getRandomValues)c.getRandomValues(a);else for(var i=0;i<12;i++)a[i]=Math.floor(Math.random()*256);for(var j=0;j<12;j++)o+=('0'+a[j].toString(16)).slice(-2);return o}
var vid=cookie('visitor_id');if(!vid){vid=rid();setCookie('visitor_id',vid)}
var utms={};['source','medium','campaign','term','content'].forEach(function(k){var v=cookie('utm_'+k);if(v)utms[k]=v});
var ref='';try{if(document.referrer){var rh=new URL(document.referrer).hostname;if(rh&&rh!==location.hostname)ref=rh}}catch(e){}
var seen=funnel+step+vid,unique=!cookie(seen);if(unique)setCookie(seen,'1');
function post(url,payload,keep){var body=JSON.stringify(payload);
if(keep&&navigator.sendBeacon){try{if(navigator.sendBeacon(url,new Blob([body],{type:'text/plain'})))return Promise.resolve()}catch(e){}}
return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:!!keep})}
function base(x){var o={visitorId:vid,url:location.href.slice(0,500),utms:utms,preview:preview};for(var k in x)o[k]=x[k];return o}
if(!preview)post(api+'/api/public/events',{funnelId:funnel,stepId:step,type:'page_view',visitorId:vid,unique:unique,url:location.href.slice(0,500),utms:utms,referrer:ref||undefined},true).catch(function(){});
function qp(n){var m=location.search.match(new RegExp('[?&]'+n+'=([^&#]*)'));if(!m)return null;try{return decodeURIComponent(m[1].replace(/\\+/g,' '))}catch(e){return null}}
function fire(n,d){try{document.dispatchEvent(new CustomEvent(n,{detail:d}))}catch(e){}}
function attribution(withIds){var t={},has=false,cids={},any=false,k,fa=window.fnAds,cs=fa&&fa.consent?fa.consent():'na',ok=withIds&&cs!=='denied'&&cs!=='unknown';
['source','medium','campaign','content','term'].forEach(function(x){var v=qp('utm_'+x);if(v){t['utm_'+x]=v.slice(0,200);has=true}});
if(ok)['gclid','fbclid','ttclid','msclkid','li_fat_id'].forEach(function(x){var v=qp(x);if(v){cids[x]=v.slice(0,200);any=true}});
if(any){t.clickIds=cids;has=true}
if(ref){t.referrer=ref;has=true}
t.landing=location.pathname;
var ids={};ids.consent=cs;
if(ok){var v;if(v=cookie('_fbp'))ids.fbp=v;if(v=cookie('_fbc'))ids.fbc=v;if(v=cookie('_ttp'))ids.ttp=v;
var ga=cookie('_ga');if(ga){var gp=ga.split('.');if(gp.length>=4)ids.gaClientId=gp[2]+'.'+gp[3]}
var ck=document.cookie.split('; ');for(k=0;k<ck.length;k++){var m=ck[k].match(/^_ga_[A-Z0-9]+=GS\\d\\.\\d\\.(\\d+)\\./);if(m){ids.gaSessionId=m[1];break}}}
return{has:has,touch:t,ids:ids}}
var attrSent='';
function sendAttribution(force){if(preview)return;var a=attribution(true),sig=JSON.stringify(a.ids)+(a.has?JSON.stringify(a.touch):'');
if(!force&&!a.has&&cookie('fn_a'))return;if(sig===attrSent)return;attrSent=sig;setCookie('fn_a','1');
post(api+'/api/public/attribution',{funnelId:funnel,stepId:step,visitorId:vid,touch:a.has?a.touch:undefined,ids:a.ids},true).catch(function(){})}
sendAttribution(false);
setTimeout(function(){sendAttribution(true)},2500);
document.addEventListener('fn:consent',function(){sendAttribution(true)});
window.addEventListener('message',function(e){var d=e.data;if(!d||typeof d!=='object'||preview)return;
if(d.type==='new_form_submission'&&d.response_id)post(api+'/api/public/events',{funnelId:funnel,stepId:step,type:'optin',visitorId:vid,externalId:String(d.response_id).slice(0,100),url:location.href.slice(0,500),utms:utms},true).catch(function(){})});
function status(el){return el.querySelector('.fn-status')}
function say(el,msg,ok){var h=el.closest&&el.closest('[data-fn-upsell-box]')||el,p=status(h);if(!p)return;p.textContent=msg;p.className='fn-status '+(ok?'fn-ok':'fn-error')}
function done(el,j){if(j&&j.redirect){location.href=j.redirect;return}var t=el.getAttribute('data-success');
if(t==='message'||el.getAttribute('data-href')==='#'){say(el,el.getAttribute('data-message')||'Thank you!',true);return}
location.href=el.getAttribute('data-href')}
function fail(el,r){var e=r&&r.error||{},f=e.details&&e.details.fields,m=e.message||'Something went wrong. Please try again.';
if(f){var parts=[];for(var k in f){parts.push(f[k]);var i=el.elements&&el.elements[k];if(i&&i.setAttribute)i.setAttribute('aria-invalid','true')}m=parts.join(' ')}
if(e.code==='PAYMENT_FAILED')m='Your payment was declined. Please try another method.';say(el,m,false)}
function send(el,url,payload,onOk){var b=el.querySelector('button[type=submit],button[data-fn-upsell]')||(el.matches&&el.matches('button')?el:null);if(b)b.disabled=true;say(el,'Working…',true);
post(url,payload,false).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(b)b.disabled=false;if(x.ok){if(!(x.j&&x.j.redirect))onOk(x.j);done(el,x.j)}else fail(el,x.j)}).catch(function(){if(b)b.disabled=false;say(el,'Network error. Please try again.',false)})}
function fields(f){var o={},i,e;for(i=0;i<f.elements.length;i++){e=f.elements[i];if(!e.name||e.name==='_hp'||e.name==='_consent'||e.name==='bump'||e.disabled)continue;o[e.name]=e.type==='checkbox'?e.checked:e.value}return o}
document.addEventListener('submit',function(ev){var f=ev.target;if(!f||!f.hasAttribute)return;
if(f.hasAttribute('data-fn-form')){ev.preventDefault();var hp=f.elements._hp,c=f.elements._consent;
var sid=rid();send(f,f.getAttribute('action'),base({fields:fields(f),_hp:hp?hp.value:'',consent:c?c.checked:undefined,submissionId:sid}),function(){f.reset();fire('fn:lead',{eventId:'lead_'+sid})})}
else if(f.hasAttribute('data-fn-checkout')){ev.preventDefault();var bumps=[],n=document.querySelectorAll('input[name="bump"]'),k;
for(k=0;k<n.length;k++)if(n[k].checked&&n[k].getAttribute('form')===f.id)bumps.push(n[k].value);
send(f,f.getAttribute('action'),base({email:f.elements.email.value,name:f.elements.name?f.elements.name.value:'',bumpBlockIds:bumps,quantity:f.elements.quantity?parseInt(f.elements.quantity.value,10)||1:undefined,_hp:f.elements._hp?f.elements._hp.value:'',submissionId:rid()}),function(j){if(j&&j.orderId){setCookie('funnels_order',j.orderId);fire('fn:purchase',{orderId:j.orderId,eventId:'purchase_'+j.orderId,orders:j.orders})}})}});
document.addEventListener('click',function(ev){var b=ev.target;while(b&&b.hasAttribute&&!b.hasAttribute('data-fn-upsell'))b=b.parentNode;if(!b||!b.hasAttribute)return;ev.preventDefault();
var prev=cookie('funnels_order');if(!prev&&!preview){say(b,'Please complete your first purchase before adding this offer.',false);return}
send(b,b.getAttribute('data-action'),base({previousOrderId:prev||'preview',submissionId:rid()}),function(j){if(j&&j.orderId)fire('fn:purchase',{orderId:j.orderId,eventId:'purchase_'+j.orderId,orders:j.orders})})});
})();`;
