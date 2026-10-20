// Runs inside the sandboxed builder canvas (scripts allowed, no same-origin access). It only reports clicks/scroll to the editor and highlights the selected block.
// It is a static file, not an inline script: the app's CSP is script-src 'self', and the srcdoc canvas inherits it, so an inline script is blocked.
(function(){var sel=null;function mark(){var a=document.querySelectorAll('[data-bid]');for(var i=0;i<a.length;i++){a[i].classList.toggle('fn-sel',a[i].getAttribute('data-bid')===sel)}}
document.addEventListener('click',function(e){e.preventDefault();var el=e.target&&e.target.closest?e.target.closest('[data-bid]'):null;parent.postMessage({fnEditor:true,type:'select',id:el?el.getAttribute('data-bid'):null},'*')},true);
document.addEventListener('submit',function(e){e.preventDefault()},true);
window.addEventListener('message',function(e){var d=e.data;if(!d||!d.fnEditor)return;if(d.type==='select'){sel=d.id;mark()}if(d.type==='scroll')window.scrollTo(0,d.y)});
var t=0;window.addEventListener('scroll',function(){clearTimeout(t);t=setTimeout(function(){parent.postMessage({fnEditor:true,type:'scroll',y:window.scrollY},'*')},100)});
parent.postMessage({fnEditor:true,type:'ready'},'*')})();
