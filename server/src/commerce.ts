/**
 * The cart and Payment form part of the beacon (docs/PRODUCTS.md#cart, docs/STRIPE.md#embedded-payment-form). Plain ES5, inserted into the beacon's closure (it uses
 * its helpers: cookie, setCookie, rid, vid, funnel, step, api, preview, utms, say, done, fire, qp). Everything it shows comes from the server's answers, built with
 * DOM APIs (textContent), never from HTML strings.
 *  - Add to cart forms, the Cart block (quantity +/-, remove, order bumps, totals), the Cart count badge; the cart token lives in a first-party cookie of the page host.
 *  - The Payment form: asks the server for a quote (the PaymentIntent and its client secret), loads Stripe.js from js.stripe.com ONLY on pages with this form and
 *    mounts the Payment Element (card data stays in Stripe's iframe), re-quotes when an order bump changes, confirms with Stripe.js (3-D Secure included) and tells
 *    the server, which re-reads the PaymentIntent and records the orders. A sandboxed page (opaque origin, owner custom code on a built-in address) cannot run
 *    Stripe.js: it falls back to the hosted Stripe Checkout redirect.
 *  - Without Stripe: a TEST card form rendered here. The numbers never leave the browser; only the outcome of the documented test card is sent. Its TEST label
 *    is styled inline and checked for visibility before every payment, so a page cannot hide it.
 */
export const COMMERCE_JS = `
var CK='fn_cart_'+funnel,cartState=null,cartBumps=[],cartBlockRef=null;
function ctoken(){return cookie(CK)||''}
function jpost(url,body){body.token=ctoken();body.visitorId=vid;body.preview=preview;
return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit'}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,j:j}},function(){return{ok:false,status:r.status,j:null}})})}
function mk(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined&&x!==null)e.textContent=String(x);return e}
function clear(e){while(e&&e.firstChild)e.removeChild(e.firstChild)}
function errOf(x){var e=x&&x.j&&x.j.error;return e&&e.message?e.message:'Something went wrong. Please try again.'}
function gotCart(j){if(!j)return;if(j.token)setCookie(CK,j.token);cartState=j.cart||null;cartBumps=cartState&&cartState.bumps||[];paintCount();paintCarts()}
function paintCount(){var n=cartState?cartState.count:0,b=document.querySelectorAll('[data-fn-cart-count]'),i;for(i=0;i<b.length;i++){var s=b[i].querySelector('[data-fn-cart-n]');if(s)s.textContent=String(n);b[i].setAttribute('aria-label',(b[i].getAttribute('data-label')||'Cart')+', '+n+(n===1?' item':' items'))}}
function cartUpdate(box,body){var st=box&&box.querySelector('.fn-status');body.opId=rid();if(cartBlockRef)body.cartBlock=cartBlockRef;
jpost(api+'/api/public/cart/'+encodeURIComponent(funnel)+'/update',body).then(function(x){if(x.ok)gotCart(x.j);else if(st){st.textContent=errOf(x);st.className='fn-status fn-error'}}).catch(function(){if(st){st.textContent='Network error. Please try again.';st.className='fn-status fn-error'}})}
function paintCarts(){var cs=document.querySelectorAll('[data-fn-cart]'),i;for(i=0;i<cs.length;i++)paintCart(cs[i])}
function paintCart(box){var body=box.querySelector('[data-fn-cart-body]'),go=box.querySelector('[data-fn-cart-checkout]'),c=cartState;if(!body)return;clear(body);
if(!c||!c.lines.length){body.appendChild(mk('p','fn-cart-empty',box.getAttribute('data-empty')||'Your cart is empty.'));if(go){go.setAttribute('aria-disabled','true');go.classList.add('fn-disabled')}return}
if(go){go.removeAttribute('aria-disabled');go.classList.remove('fn-disabled')}
var ul=mk('ul','fn-cart-lines');ul.setAttribute('aria-label','Items in your cart');
c.lines.forEach(function(l){var li=mk('li','fn-cart-line'),info=mk('div','fn-cart-info');info.appendChild(mk('span','fn-cart-name',l.name));info.appendChild(mk('span','fn-cart-unit',l.available?l.unit+' each':'No longer available'));li.appendChild(info);
var q=mk('div','fn-qty');q.setAttribute('role','group');q.setAttribute('aria-label','Quantity of '+l.name);
var m=mk('button',null,'\\u2212');m.type='button';m.setAttribute('aria-label','One less '+l.name);m.onclick=function(){cartUpdate(box,{itemId:l.id,quantity:l.quantity-1})};
var o=mk('output',null,l.quantity);o.setAttribute('aria-label',l.quantity+' of '+l.name);
var p=mk('button',null,'+');p.type='button';p.setAttribute('aria-label','One more '+l.name);p.disabled=l.quantity>=l.max||!l.available;p.onclick=function(){cartUpdate(box,{itemId:l.id,quantity:l.quantity+1})};
q.appendChild(m);q.appendChild(o);q.appendChild(p);li.appendChild(q);li.appendChild(mk('span','fn-cart-sum',l.available?l.total:''));
var rm=mk('button','fn-cart-remove','Remove');rm.type='button';rm.setAttribute('aria-label','Remove '+l.name);rm.onclick=function(){cartUpdate(box,{itemId:l.id,quantity:0})};li.appendChild(rm);ul.appendChild(li)});
body.appendChild(ul);
if(box.getAttribute('data-bumps')==='1'&&cartBlockRef&&cartBlockRef.blockId===box.getAttribute('data-block'))cartBumps.forEach(function(b){var lab=mk('label','fn-bump'),cb=mk('input');cb.type='checkbox';cb.checked=!!b.selected;cb.onchange=function(){cartUpdate(box,{bump:{stepId:b.stepId,blockId:b.blockId,selected:cb.checked}})};
var t=mk('span');t.appendChild(mk('strong',null,'Yes, add '+b.name+' for '+b.formatted));if(b.description){t.appendChild(mk('br'));t.appendChild(document.createTextNode(b.description))}lab.appendChild(cb);lab.appendChild(document.createTextNode(' '));lab.appendChild(t);body.appendChild(lab)});
var tot=mk('div','fn-totals'),r1=mk('div');r1.appendChild(mk('span',null,'Subtotal'));r1.appendChild(mk('span',null,c.subtotalFormatted));tot.appendChild(r1);
cartBumps.forEach(function(b){if(!b.selected)return;var r=mk('div');r.appendChild(mk('span',null,b.name));r.appendChild(mk('span',null,b.formatted));tot.appendChild(r)});
var r2=mk('div','fn-total');r2.appendChild(mk('span',null,'Total'));r2.appendChild(mk('span',null,c.totalFormatted));tot.appendChild(r2);body.appendChild(tot)}
function loadCart(){var cb=document.querySelector('[data-fn-cart]');cartBlockRef=cb?{stepId:step,blockId:cb.getAttribute('data-block')}:null;
var need=document.querySelector('[data-fn-cart],[data-fn-cart-count]');if(!need)return;
jpost(api+'/api/public/cart/'+encodeURIComponent(funnel)+'/view',cartBlockRef?{cartBlock:cartBlockRef}:{}).then(function(x){if(x.ok)gotCart(x.j)}).catch(function(){})}
function addToCart(f){var b=f.querySelector('button[type=submit]'),q=f.elements.quantity?parseInt(f.elements.quantity.value,10)||1:undefined,body={opId:rid(),quantity:q,url:location.href.slice(0,500),utms:utms};if(cartBlockRef)body.cartBlock=cartBlockRef;
if(b)b.disabled=true;say(f,'Adding\\u2026',true);
jpost(f.getAttribute('action'),body).then(function(x){if(b)b.disabled=false;if(!x.ok){say(f,errOf(x),false);return}gotCart(x.j);
if(x.j.eventId&&x.j.added)fire('fn:add_to_cart',{eventId:x.j.eventId,item:x.j.added});var h=f.getAttribute('data-href');if(h&&h!=='#'){location.href=h;return}
say(f,x.j.limited?'Added (this is the most you can buy at once).':'Added to your cart.',true)}).catch(function(){if(b)b.disabled=false;say(f,'Network error. Please try again.',false)})}
var stripeJs=null;
function loadStripe(cb){if(window.Stripe)return cb(null);if(stripeJs){stripeJs.push(cb);return}stripeJs=[cb];var s=document.createElement('script');s.src='https://js.stripe.com/v3/';s.async=true;
s.onload=function(){var l=stripeJs;stripeJs=null;for(var i=0;i<l.length;i++)l[i](window.Stripe?null:'unavailable')};s.onerror=function(){var l=stripeJs;stripeJs=null;for(var i=0;i<l.length;i++)l[i]('unavailable')};(document.head||document.documentElement).appendChild(s)}
function sget(k){try{return sessionStorage.getItem(k)}catch(e){return null}}
function sset(k,v){try{if(v)sessionStorage.setItem(k,v);else sessionStorage.removeItem(k)}catch(e){}}
function sandboxed(){try{return window.origin==='null'||location.origin==='null'}catch(e){return true}}
function payStatus(st,msg,ok){var p=st.f.querySelector('.fn-status');if(!p)return;p.textContent=msg;p.className='fn-status '+(ok?'fn-ok':'fn-error')}
function bumpsOf(f){var o=[],n=document.querySelectorAll('input[name="bump"]'),i;for(i=0;i<n.length;i++)if(n[i].checked&&n[i].getAttribute('form')===f.id)o.push(n[i].value);return o}
function qtyOf(f){return f.elements.quantity?parseInt(f.elements.quantity.value,10)||1:undefined}
function paintSummary(st,s){var box=st.f.querySelector('[data-fn-pay-summary]');if(!box||!s)return;clear(box);var ul=mk('ul','fn-pay-lines');ul.setAttribute('aria-label','Your order');
s.lines.forEach(function(l){var li=mk('li','fn-pay-line');li.appendChild(mk('span',null,l.name+(l.quantity>1?' \\u00d7 '+l.quantity:'')));li.appendChild(mk('span',null,l.total));ul.appendChild(li)});box.appendChild(ul);
var t=mk('div','fn-totals'),r=mk('div','fn-total');r.appendChild(mk('span',null,'Total'));r.appendChild(mk('span',null,s.totalFormatted));t.appendChild(r);box.appendChild(t);
var b=st.f.querySelector('button[type=submit]');if(b&&st.label)b.textContent=st.label+' \\u00b7 '+s.totalFormatted}
function cardBox(st){return st.f.querySelector('[data-fn-pay-card]')}
function quote(st,extra){var body={attemptId:st.attempt||undefined,quantity:qtyOf(st.f),utms:utms,url:location.href.slice(0,500)},k;if(st.bumpsTouched)body.bumpBlockIds=bumpsOf(st.f);for(k in extra)body[k]=extra[k];
return jpost(st.f.getAttribute('action'),body).then(function(x){if(x.ok&&x.j){if(x.j.attemptId){st.attempt=x.j.attemptId;sset(st.key,st.attempt)}st.provider=x.j.provider;if(x.j.summary){st.total=x.j.summary.total;paintSummary(st,x.j.summary)}
if(!st.bumpsTouched&&x.j.bumpBlockIds){var n=document.querySelectorAll('input[name="bump"]'),i;for(i=0;i<n.length;i++)if(n[i].getAttribute('form')===st.f.id)n[i].checked=x.j.bumpBlockIds.indexOf(n[i].value)>=0}
if(x.j.mode==='hosted')st.hosted=true;if(x.j.eventId&&!st.icSent){st.icSent=true;fire('fn:begin_checkout',{eventId:x.j.eventId,summary:x.j.summary})}}return x})}
function testBanner(){var lab=mk('div','fn-pay-test','TEST MODE \\u00b7 No real payment is taken. Use 4242 4242 4242 4242 (paid), 4000 0000 0000 0002 (declined) or 4000 0025 0000 3155 (needs authentication), any future date and any CVC.');lab.setAttribute('role','note');lab.setAttribute('data-fn-test','1');
lab.setAttribute('style','display:block!important;visibility:visible!important;opacity:1!important;position:static!important;clip:auto!important;clip-path:none!important;transform:none!important;width:auto!important;height:auto!important;max-height:none!important;overflow:visible!important;filter:none!important;background:#fef3c7!important;color:#78350f!important;border:2px solid #b45309!important;border-radius:8px!important;padding:8px 10px!important;margin:0 0 10px!important;font:600 13px/1.45 system-ui,sans-serif!important;text-indent:0!important;font-size:13px!important');return lab}
function shown(el){if(!el||!el.isConnected||!el.getBoundingClientRect)return false;var r=el.getBoundingClientRect();if(r.width<120||r.height<16)return false;
for(var p=el;p&&p.nodeType===1;p=p.parentElement){var s=getComputedStyle(p);if(s.display==='none'||s.visibility!=='visible'&&p===el||s.visibility==='hidden'||parseFloat(s.opacity)<0.9)return false}return true}
function mountMock(st){var c=cardBox(st);if(!c)return;clear(c);st.lab=testBanner();c.appendChild(st.lab);var w=mk('div','fn-pay-mock');
function inp(ph,lab,mode){var i=mk('input');i.type='text';i.setAttribute('inputmode',mode||'numeric');i.setAttribute('autocomplete','off');i.setAttribute('placeholder',ph);i.setAttribute('aria-label',lab);i.setAttribute('data-fn-test-card','1');return i}
st.cn=inp('1234 1234 1234 1234','Test card number');st.ce=inp('MM / YY','Test card expiry');st.cc=inp('CVC','Test card security code');var row=mk('div','fn-pay-row');row.appendChild(st.ce);row.appendChild(st.cc);w.appendChild(st.cn);w.appendChild(row);c.appendChild(w);st.ready=true}
function luhn(d){var s=0,alt=false;for(var i=d.length-1;i>=0;i--){var n=+d.charAt(i);if(alt){n*=2;if(n>9)n-=9}s+=n;alt=!alt}return s%10===0}
function mockOutcome(st){var d=(st.cn.value||'').replace(/\\D/g,''),e=(st.ce.value||'').replace(/\\s/g,''),c=(st.cc.value||'').replace(/\\s/g,''),m=e.match(/^(\\d{2})\\/?(\\d{2})$/);
if(d.length<13||d.length>19||!luhn(d))return{error:'Enter a valid card number.',el:st.cn};
if(!m||+m[1]<1||+m[1]>12)return{error:'Enter the expiry date as MM / YY.',el:st.ce};var now=new Date(),y=2000+(+m[2]);if(y<now.getFullYear()||y===now.getFullYear()&&+m[1]<now.getMonth()+1)return{error:'This card has expired.',el:st.ce};
if(!/^\\d{3,4}$/.test(c))return{error:'Enter the 3 or 4 digit security code.',el:st.cc};
var map={'4242424242424242':'success','4000000000000002':'decline','4000000000009995':'decline','4000002500003155':'authenticate','4000000000003220':'authenticate'};
return map[d]?{outcome:map[d]}:{error:'This is a test payment form: use one of the test cards shown above.',el:st.cn}}
function mountStripe(st,s){var c=cardBox(st);if(!c)return;if(sandboxed()){st.hosted=true;clear(c);c.appendChild(mk('p','fn-note','You will enter your card on Stripe\\u2019s secure checkout page.'));return}
loadStripe(function(err){if(err||!window.Stripe){st.hosted=true;clear(c);c.appendChild(mk('p','fn-note','Secure card fields could not load here. You will enter your card on Stripe\\u2019s secure checkout page.'));return}
try{st.stripe=window.Stripe(s.publishableKey,{stripeAccount:s.account});var bg=getComputedStyle(st.f).backgroundColor||'',rgb=bg.match(/\\d+/g),dark=rgb&&rgb.length>=3&&(0.299*rgb[0]+0.587*rgb[1]+0.114*rgb[2])<128;
st.elements=st.stripe.elements({clientSecret:s.clientSecret,appearance:{theme:dark?'night':'stripe'}});st.pe=st.elements.create('payment',{layout:'tabs'});clear(c);var host=mk('div');c.appendChild(host);st.pe.mount(host);st.ready=true}
catch(e){st.hosted=true;clear(c);c.appendChild(mk('p','fn-note','You will enter your card on Stripe\\u2019s secure checkout page.'))}})}
function payInit(f){if(f.__fnPay)return;var st={f:f,key:'fn_pay_'+funnel+'_'+f.id,mode:f.getAttribute('data-mode')},b=f.querySelector('button[type=submit]');st.label=b?b.textContent:'Pay now';f.__fnPay=st;st.attempt=sget(st.key);
var q=qp('payment');if(q==='failed')payStatus(st,'The payment was not completed (authentication failed or was cancelled). Please try again.',false);else if(q==='processing')payStatus(st,'Your payment is still processing. You will receive a confirmation by email.',true);
var n=document.querySelectorAll('input[name="bump"]'),i;for(i=0;i<n.length;i++)if(n[i].getAttribute('form')===f.id)n[i].addEventListener('change',function(){st.bumpsTouched=true;quote(st,{}).then(function(x){if(x.ok&&st.elements)st.elements.fetchUpdates();else if(!x.ok)payStatus(st,errOf(x),false)}).catch(function(){payStatus(st,'Network error. Please try again.',false)})});
if(f.elements.quantity)f.elements.quantity.addEventListener('change',function(){quote(st,{}).then(function(x){if(x.ok&&st.elements)st.elements.fetchUpdates()})});
quote(st,{}).then(function(x){if(!x.ok){var c=cardBox(st);if(x.j&&x.j.error&&x.j.error.code==='CART_EMPTY'){var sm=f.querySelector('[data-fn-pay-summary]');clear(sm);sm.appendChild(mk('p','fn-cart-empty','Your cart is empty.'));if(b)b.disabled=true;clear(c);return}payStatus(st,errOf(x),false);return}
if(preview||x.j.provider==='preview'){mountMock(st);return}
if(st.hosted){var c2=cardBox(st);clear(c2);c2.appendChild(mk('p','fn-note',x.j.provider==='stripe'?'You will enter your card on Stripe\\u2019s secure checkout page.':'Test mode: no card is needed and no real payment is taken.'));if(x.j.provider!=='stripe')c2.insertBefore(testBanner(),c2.firstChild);st.lab=c2.firstChild;st.ready=true;return}
if(x.j.provider==='stripe'&&x.j.stripe){st.returnUrl=x.j.returnUrl;mountStripe(st,x.j.stripe)}else mountMock(st)}).catch(function(){payStatus(st,'Network error. Please reload the page.',false)})}
function contactOf(st){var f=st.f,E=f.elements,c={email:(E.email&&E.email.value||'').trim()};if(E.name)c.name=E.name.value.trim();
if(f.getAttribute('data-address')==='1')c.address={line1:E.line1?E.line1.value.trim():'',city:E.city?E.city.value.trim():'',postalCode:E.postalCode?E.postalCode.value.trim():'',country:E.country?E.country.value.trim().toUpperCase():''};return c}
function invalid(st,fields){var k,first=null,msgs=[];for(k in fields){var i=st.f.elements[k==='postalCode'?'postalCode':k];if(i&&i.setAttribute){i.setAttribute('aria-invalid','true');if(!first)first=i}msgs.push(fields[k])}payStatus(st,msgs[0]||'Check the highlighted fields.',false);if(first&&first.focus)first.focus()}
function checkLocal(st,c){var f={};if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(c.email))f.email='Enter a valid email address';if(c.address){if(!c.address.line1)f.line1='Enter your address';if(!c.address.city)f.city='Enter your city';if(!c.address.postalCode)f.postalCode='Enter your postal code';if(!/^[A-Z]{2}$/.test(c.address.country))f.country='Use the 2-letter country code (for example US)'}return f}
function busy(st,on){st.busy=on;var b=st.f.querySelector('button[type=submit]');if(b){b.disabled=on;b.setAttribute('aria-busy',on?'true':'false')}}
function paid(st,j){sset(st.key,null);if(j.orderId){setCookie('funnels_order',j.orderId);fire('fn:purchase',{orderId:j.orderId,eventId:'purchase_'+j.orderId,orders:j.orders})}cartState=null;paintCount();payStatus(st,'Payment received. Thank you!',true);done(st.f,{})}
function failText(x){var e=x&&x.j&&x.j.error,r=e&&e.details&&e.details.reason;if(e&&e.code==='PAYMENT_FAILED')return r==='authentication_failed'||r==='authentication_required'?'The card could not be authenticated. Please try again or use another card.':'Your card was declined. Please try another card.';return errOf(x)}
function complete(st,extra,tries){var body={attemptId:st.attempt},k;for(k in extra)body[k]=extra[k];
return jpost(api+'/api/public/pay/complete',body).then(function(x){if(x.ok&&x.j.requiresAction){testAuth(function(ok){complete(st,{test:'authenticate',authenticated:ok},0)});return}
if(x.ok&&x.j.pending){if((tries||0)<6){payStatus(st,'Your payment is processing\\u2026',true);setTimeout(function(){complete(st,extra,(tries||0)+1)},2000)}else{busy(st,false);payStatus(st,'Your payment is still processing. You will receive a confirmation by email.',true)}return}
if(x.ok&&x.j.orderId){paid(st,x.j);return}busy(st,false);payStatus(st,failText(x),false)}).catch(function(){busy(st,false);payStatus(st,'Network error: we could not confirm the payment. Please try again; you will not be charged twice.',false)})}
function testAuth(cb){var o=mk('div','fn-pay-dialog'),d=mk('div');o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');o.setAttribute('aria-label','Test authentication');
d.appendChild(testBanner());d.appendChild(mk('strong',null,'Authenticate this test payment'));d.appendChild(mk('p',null,'Your bank would ask you to confirm this payment now. This is a simulation: choose an outcome.'));
var y=mk('button','fn-btn fn-btn-primary','Complete authentication'),n=mk('button','fn-btn fn-btn-outline','Fail authentication');y.type=n.type='button';
function close(v){if(o.parentNode)o.parentNode.removeChild(o);cb(v)}y.onclick=function(){close(true)};n.onclick=function(){close(false)};d.appendChild(y);d.appendChild(n);o.appendChild(d);document.body.appendChild(o);y.focus()}
function paySubmit(f){var st=f.__fnPay;if(!st||st.busy)return;var E=f.elements,i;for(i=0;i<E.length;i++)if(E[i].removeAttribute)E[i].removeAttribute('aria-invalid');
if(E._hp&&E._hp.value)return;var c=contactOf(st),bad=checkLocal(st,c),k,any=false;for(k in bad)any=true;if(any){invalid(st,bad);return}
if(!st.ready){payStatus(st,'The card fields are still loading. Please wait a moment.',false);return}
if(st.lab&&!shown(st.lab)){payStatus(st,'This test payment form must show its TEST label.',false);return}
if(preview){payStatus(st,'Preview: no payment is taken.',true);done(f,{});return}
var mo=null;if(st.cn){mo=mockOutcome(st);if(mo.error){mo.el.setAttribute('aria-invalid','true');payStatus(st,mo.error,false);mo.el.focus();return}}
busy(st,true);payStatus(st,'Processing\\u2026',true);
if(st.hosted){quote(st,{contact:c,hosted:true}).then(function(x){if(!x.ok){busy(st,false);if(x.j&&x.j.error&&x.j.error.details&&x.j.error.details.fields)invalid(st,x.j.error.details.fields);else payStatus(st,errOf(x),false);return}
if(x.j.redirect){location.href=x.j.redirect;return}if(x.j.orderId){paid(st,x.j);return}busy(st,false)}).catch(function(){busy(st,false);payStatus(st,'Network error. Please try again.',false)});return}
function quoteErr(st,x){busy(st,false);if(x.j&&x.j.error&&x.j.error.code==='ALREADY_PAID'){busy(st,true);complete(st,{});return}if(x.j&&x.j.error&&x.j.error.details&&x.j.error.details.fields)invalid(st,x.j.error.details.fields);else payStatus(st,errOf(x),false)}
if(mo){quote(st,{contact:c}).then(function(x){if(!x.ok){quoteErr(st,x);return}complete(st,{test:mo.outcome})}).catch(function(){busy(st,false);payStatus(st,'Network error. Please try again.',false)});return}
if(!st.stripe){busy(st,false);payStatus(st,'The card fields are not ready. Please reload the page.',false);return}
// Stripe: validate the Payment Element first (inside the click, as wallets require), then save the buyer details on the PaymentIntent, then confirm (3-D Secure runs here).
var before=st.total;
st.elements.submit().then(function(r){if(r&&r.error){busy(st,false);payStatus(st,r.error.message||'Check your card details.',false);return null}
return quote(st,{contact:c}).then(function(x){if(!x.ok){quoteErr(st,x);return null}return(st.total!==before?st.elements.fetchUpdates():Promise.resolve()).then(function(){
var bd={email:c.email};if(c.name)bd.name=c.name;if(c.address)bd.address={line1:c.address.line1,city:c.address.city,postal_code:c.address.postalCode,country:c.address.country};
return st.stripe.confirmPayment({elements:st.elements,confirmParams:{return_url:st.returnUrl,payment_method_data:{billing_details:bd}},redirect:'if_required'})})})}).then(function(r){if(!r)return;
if(r.error){busy(st,false);payStatus(st,r.error.type==='card_error'||r.error.type==='validation_error'?(r.error.message||'Your card was declined.'):'The payment could not be completed. Please try again.',false);return}complete(st,{})}).catch(function(){busy(st,false);payStatus(st,'Network error. Please try again.',false)})}
document.addEventListener('submit',function(ev){var f=ev.target;if(!f||!f.hasAttribute)return;if(f.hasAttribute('data-fn-cart-add')){ev.preventDefault();addToCart(f)}else if(f.hasAttribute('data-fn-pay')){ev.preventDefault();paySubmit(f)}});
var fo=qp('fn_order');if(fo&&/^ord_[A-Za-z0-9_-]{4,64}$/.test(fo))setCookie('funnels_order',fo);
function commerceStart(){loadCart();var ps=document.querySelectorAll('[data-fn-pay]'),i;for(i=0;i<ps.length;i++)payInit(ps[i])}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',commerceStart);else commerceStart();
`;
