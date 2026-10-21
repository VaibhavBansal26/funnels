/**
 * The browser side of pixels and consent: ES5, no dependencies, one inline script per page. `__CFG__` is replaced by the page's configuration, which the server builds from
 * validated identifiers (see snippets.ts) and serialises as JSON, so no pasted text ever becomes code. What it does:
 *  - decides whether tracking may run (Do Not Track / Global Privacy Control, the visitor's stored choice, the consent mode and the region rule), shows the banner when a choice is due;
 *  - Google Consent Mode v2: defines dataLayer/gtag and the four consent signals (denied until the visitor accepts when consent is required) and updates them on a choice;
 *  - loads each network's own library only after tracking is allowed, queues the events that happened meanwhile, and maps the standard events to each network's names and parameters;
 *  - in a preview it never loads a vendor library: it records what it WOULD send in `window.__fnAdsLog` and shows it in a small panel.
 * Events: PageView, ViewContent, Lead, InitiateCheckout, AddPaymentInfo, Purchase. The beacon reports Lead and Purchase with the same event id the server uses for its own
 * Conversions API event (`lead_<submissionId>`, `purchase_<first order id>`), which is what lets the networks deduplicate browser and server events.
 */
export const ADS_RUNTIME_JS = `(function(){
var C=__CFG__,w=window,d=document,P=C.p||{},cc=C.consent||{},preview=C.mode==='preview',log=w.__fnAdsLog=[];
function ck(n){try{var m=d.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?decodeURIComponent(m[1]):null}catch(e){return null}}
function setCk(n,v,days){try{d.cookie=n+'='+encodeURIComponent(v)+'; path=/; max-age='+days*86400+'; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'')}catch(e){}}
function rid(){var a=new Uint8Array(8),c=w.crypto||w.msCrypto,o='',i;if(c&&c.getRandomValues)c.getRandomValues(a);else for(i=0;i<8;i++)a[i]=Math.floor(Math.random()*256);for(i=0;i<8;i++)o+=('0'+a[i].toString(16)).slice(-2);return o}
var dnt=navigator.doNotTrack==='1'||w.doNotTrack==='1'||navigator.msDoNotTrack==='1'||navigator.globalPrivacyControl===true;
function inRegion(){if(cc.regions!=='eu_uk')return true;try{var tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'';return!tz||/^(Europe\\/|Atlantic\\/(Azores|Madeira|Canary|Faroe|Reykjavik)|Africa\\/Ceuta)/.test(tz)}catch(e){return true}}
var consentOn=!!cc.enabled&&inRegion(),stored=ck('fn_consent'),state;
if(cc.respectDnt&&dnt)state='denied';
else if(stored==='granted'||stored==='denied')state=stored;
else state=consentOn&&cc.mode!=='opt_out'?'unknown':'granted';
var loaded=false,queue=[],eventsSeen={};
var googleOn=!!(P.ga4||P.ads);
if(googleOn&&!preview){w.dataLayer=w.dataLayer||[];w.gtag=w.gtag||function(){w.dataLayer.push(arguments)};}
function gsignals(v){return{ad_storage:v,analytics_storage:v,ad_user_data:v,ad_personalization:v}}
if(googleOn&&!preview&&consentOn){var def=gsignals(state==='granted'?'granted':'denied');def.wait_for_update=500;w.gtag('consent','default',def)}
function note(net,fn,args){log.push({network:net,call:fn,args:args});if(preview)panel()}
function script(src,cb){var s=d.createElement('script');s.async=true;s.src=src;if(cb)s.onload=cb;(d.head||d.documentElement).appendChild(s)}
function items(list){var o=[],i;for(i=0;i<(list||[]).length;i++){var x=list[i];o.push({item_id:x.id,item_name:x.name,price:x.price,quantity:x.quantity||1})}return o}
function ids(list){var o=[],i;for(i=0;i<(list||[]).length;i++)o.push(list[i].id);return o}
function qty(list){var o=[],i;for(i=0;i<(list||[]).length;i++)o.push({id:list[i].id,quantity:list[i].quantity||1,item_price:list[i].price});return o}
function tkc(list){var o=[],i;for(i=0;i<(list||[]).length;i++)o.push({content_id:list[i].id,content_name:list[i].name,quantity:list[i].quantity||1,price:list[i].price});return o}
var N={};
N.meta=function(n,p,e){var it=p.items||[],base={};
if(n==='PageView'||n==='Lead')return['track',n,{},{eventID:e}];
base.content_ids=ids(it);base.value=p.value;base.currency=p.currency;
if(n==='ViewContent'){base.content_type='product';if(it[0])base.content_name=it[0].name;return['track',n,base,{eventID:e}]}
base.contents=qty(it);base.content_type='product';base.num_items=it.length;return['track',n,base,{eventID:e}]};
N.ga4=function(n,p){var m={PageView:'page_view',ViewContent:'view_item',Lead:'generate_lead',InitiateCheckout:'begin_checkout',AddPaymentInfo:'add_payment_info',Purchase:'purchase'},o={};
if(n==='PageView'){o.page_title=d.title;o.page_location=location.href;return['event','page_view',o]}
if(p.currency)o.currency=p.currency;if(p.value!==undefined)o.value=p.value;if(n==='Purchase')o.transaction_id=p.orderId;if(p.items&&p.items.length)o.items=items(p.items);return['event',m[n],o]};
N.tiktok=function(n,p,e){var m={ViewContent:'ViewContent',Lead:'SubmitForm',InitiateCheckout:'InitiateCheckout',AddPaymentInfo:'AddPaymentInfo',Purchase:'CompletePayment'},o={};
if(n==='PageView')return['page'];
if(p.currency)o.currency=p.currency;if(p.value!==undefined)o.value=p.value;if(p.items&&p.items.length){o.contents=tkc(p.items);o.content_type='product'}return['track',m[n],o,{event_id:e}]};
function emit(net,args){note(net,args[0],args.slice(1));if(preview)return;
try{if(net==='meta'&&w.fbq)w.fbq.apply(w,args);else if(net==='ga4'&&w.gtag)w.gtag.apply(w,args);else if(net==='tiktok'&&w.ttq){var f=args[0];w.ttq[f].apply(w.ttq,args.slice(1))}}catch(e){}}
function dispatch(n,p,e){var a;p=p||{};
if(P.meta){a=N.meta(n,p,e);emit('meta',a)}
if(P.ga4){a=N.ga4(n,p,e);emit('ga4',a)}
if(P.ads&&(n==='Purchase'||n==='Lead')){var lab=n==='Purchase'?P.ads.pl:P.ads.ll;if(lab){var o={send_to:P.ads.id+'/'+lab};if(p.value!==undefined){o.value=p.value;o.currency=p.currency}if(n==='Purchase')o.transaction_id=p.orderId;emit('ga4',['event','conversion',o])}}
if(P.tiktok){a=N.tiktok(n,p,e);emit('tiktok',a)}
if(P.li&&(n==='Purchase'||n==='Lead')){var cid=n==='Purchase'?P.li.pc:P.li.lc;if(cid){note('linkedin','track',[{conversion_id:Number(cid)}]);if(!preview&&w.lintrk)try{w.lintrk('track',{conversion_id:Number(cid)})}catch(x){}}}
if(P.uet&&(n==='Purchase'||n==='Lead')){var uo=n==='Purchase'?{revenue_value:p.value,currency:p.currency}:{};note('uet','event',[n==='Purchase'?'purchase':'lead',uo]);if(!preview&&w.uetq)try{w.uetq.push('event',n==='Purchase'?'purchase':'lead',uo)}catch(x2){}}}
function load(){if(loaded)return;loaded=true;
if(!preview){
if(P.meta){if(!w.fbq){var n=w.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!w._fbq)w._fbq=n;n.push=n;n.loaded=true;n.version='2.0';n.queue=[];script('https://connect.facebook.net/en_US/fbevents.js')}w.fbq('init',P.meta.id)}
if(googleOn){script('https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(P.ga4?P.ga4.id:P.ads.id));w.gtag('js',new Date());if(P.ga4)w.gtag('config',P.ga4.id,{send_page_view:false});if(P.ads)w.gtag('config',P.ads.id)}
if(P.tiktok){var t=w.TiktokAnalyticsObject='ttq',q=w[t]=w[t]||[];q._i=q._i||{};q.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie'];q.setAndDefer=function(o,m){o[m]=function(){o.push([m].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<q.methods.length;i++)q.setAndDefer(q,q.methods[i]);q._i[P.tiktok.id]=[];q._t=q._t||{};q._t[P.tiktok.id]=+new Date;q._o=q._o||{};q._o[P.tiktok.id]={};script('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid='+encodeURIComponent(P.tiktok.id)+'&lib=ttq')}
if(P.li){w._linkedin_partner_id=P.li.pid;w._linkedin_data_partner_ids=w._linkedin_data_partner_ids||[];w._linkedin_data_partner_ids.push(P.li.pid);script('https://snap.licdn.com/li.lms-analytics/insight.min.js')}
if(P.uet){w.uetq=w.uetq||[];script('https://bat.bing.com/bat.js',function(){var o={ti:P.uet.id,enableAutoSpaTracking:true};o.q=w.uetq;w.uetq=new w.UET(o);w.uetq.push('pageLoad')})}
}
while(queue.length){var x=queue.shift();dispatch(x[0],x[1],x[2])}}
function track(n,p,e){e=e||(n.toLowerCase()+'_'+rid());if(eventsSeen[n+e])return;eventsSeen[n+e]=1;
if(state==='denied'){note('blocked',n,[]);return}
if(state==='unknown'){note('queued',n,[]);queue.push([n,p,e]);return}
if(!loaded)load();dispatch(n,p,e)}
function setState(v,remember){state=v;if(remember)setCk('fn_consent',v,180);
if(googleOn&&!preview&&consentOn&&w.gtag)w.gtag('consent','update',gsignals(v==='granted'?'granted':'denied'));
if(v==='granted')load();else queue.length=0;
try{d.dispatchEvent(new CustomEvent('fn:consent',{detail:{state:v}}))}catch(e){}}
var box;
function banner(){if(box||preview&&!consentOn)return;if(!consentOn||(stored==='granted'||stored==='denied')&&!forced||cc.respectDnt&&dnt)return;
box=d.createElement('div');box.setAttribute('role','dialog');box.setAttribute('aria-label',cc.title||'Privacy');box.setAttribute('data-fn-consent','');
var pos=cc.position==='center'?'top:50%;left:50%;transform:translate(-50%,-50%);max-width:480px':cc.position==='bottom-left'?'bottom:16px;left:16px;max-width:420px':'bottom:16px;left:50%;transform:translateX(-50%);max-width:720px';
box.style.cssText='position:fixed;z-index:2147483000;'+pos+';width:calc(100% - 32px);background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.2);padding:16px;font:14px/1.5 system-ui,sans-serif';
var h=d.createElement('strong');h.textContent=cc.title||'';h.style.display='block';h.style.marginBottom='4px';
var p=d.createElement('p');p.textContent=cc.message||'';p.style.margin='0 0 12px';
if(cc.policyUrl){var a=d.createElement('a');a.href=cc.policyUrl;a.textContent=' Privacy policy';a.style.color='#1d4ed8';p.appendChild(a)}
var row=d.createElement('div');row.style.cssText='display:flex;gap:8px;flex-wrap:wrap';
function btn(label,primary,fn){var b=d.createElement('button');b.type='button';b.textContent=label;b.style.cssText='min-height:40px;padding:0 16px;border-radius:8px;font:600 14px system-ui,sans-serif;cursor:pointer;border:1px solid '+(primary?'#1d4ed8':'#6b7280')+';background:'+(primary?'#1d4ed8':'#fff')+';color:'+(primary?'#fff':'#111827');b.onclick=fn;return b}
row.appendChild(btn(cc.acceptLabel||'Accept',true,function(){close();setState('granted',true)}));
row.appendChild(btn(cc.rejectLabel||'Decline',false,function(){close();setState('denied',true)}));
box.appendChild(h);box.appendChild(p);box.appendChild(row);d.body.appendChild(box)}
var forced=false;
function close(){if(box&&box.parentNode)box.parentNode.removeChild(box);box=null;forced=false}
var dbg;
function panel(){if(!d.body)return;if(!dbg){dbg=d.createElement('div');dbg.setAttribute('data-fn-pixel-debug','');dbg.style.cssText='position:fixed;right:8px;top:8px;z-index:2147483001;max-width:300px;max-height:40vh;overflow:auto;background:#111827;color:#e5e7eb;font:11px/1.4 ui-monospace,monospace;padding:8px;border-radius:8px;opacity:.92';d.body.appendChild(dbg)}
var l=log[log.length-1],r=d.createElement('div');r.textContent=l.network+': '+l.call+' '+(l.args&&l.args[0]!==undefined?(typeof l.args[0]==='string'?l.args[0]:''):'');dbg.appendChild(r)}
function pageEvents(){track('PageView',{},'pv_'+rid());
var forms=d.querySelectorAll('[data-fn-checkout]'),main,i;
if(forms.length){var prods=C.products||[];for(i=0;i<prods.length;i++)if(!prods[i].bump&&!prods[i].upsell){main=prods[i];break}
if(!main&&prods[0])main=prods[0];
if(main)track('ViewContent',{items:[{id:main.id,name:main.name,price:main.price,quantity:1}],value:main.price,currency:main.currency},'vc_'+C.step)}}
var started=false;
function start(){if(started)return;started=true;if(state==='granted')load();banner();pageEvents();
d.addEventListener('focusin',function(ev){var f=ev.target&&ev.target.closest&&ev.target.closest('[data-fn-checkout]');if(f)checkoutStart(f)});
d.addEventListener('submit',function(ev){var f=ev.target;if(f&&f.hasAttribute&&f.hasAttribute('data-fn-checkout'))checkoutPay(f)},true);
d.addEventListener('click',function(ev){var t=ev.target;if(t&&t.closest&&t.closest('[data-fn-consent-settings]')){ev.preventDefault();forced=true;banner()}})}
function productFor(form){var prods=C.products||[],bid=form.id||'',i;for(i=0;i<prods.length;i++)if(bid.indexOf(prods[i].id)>=0)return prods[i];for(i=0;i<prods.length;i++)if(!prods[i].bump&&!prods[i].upsell)return prods[i];return prods[0]}
function cartOf(form){var p=productFor(form);if(!p)return{};var list=[{id:p.id,name:p.name,price:p.price,quantity:1}],tot=p.price,bumps=d.querySelectorAll('input[name="bump"]'),k,q=C.products||[],j;
for(k=0;k<bumps.length;k++)if(bumps[k].checked&&bumps[k].getAttribute('form')===form.id)for(j=0;j<q.length;j++)if(q[j].id===bumps[k].value){list.push({id:q[j].id,name:q[j].name,price:q[j].price,quantity:1});tot+=q[j].price}
return{items:list,value:Math.round(tot*100)/100,currency:p.currency}}
function checkoutStart(f){track('InitiateCheckout',cartOf(f),'ic_'+C.step)}
function checkoutPay(f){track('AddPaymentInfo',cartOf(f),'api_'+C.step+'_'+rid())}
d.addEventListener('fn:lead',function(ev){if(C.lead)track('Lead',{},ev.detail&&ev.detail.eventId)});
d.addEventListener('fn:purchase',function(ev){var dt=ev.detail||{},os=dt.orders||[],list=[],tot=0,cur=null,i,j,q=C.products||[];
for(i=0;i<os.length;i++){var id=os[i].productName;for(j=0;j<q.length;j++)if(q[j].name===os[i].productName)id=q[j].id;list.push({id:id,name:os[i].productName,price:os[i].amountCents/100,quantity:1});tot+=os[i].amountCents;cur=cur||os[i].currency}
track('Purchase',{orderId:dt.orderId,items:list,value:tot/100,currency:cur},dt.eventId)});
w.fnAds={track:track,consent:function(){return state},accept:function(){setState('granted',true)},decline:function(){setState('denied',true)},log:log};
if(d.readyState==='loading')d.addEventListener('DOMContentLoaded',start);else start();
})();`;
