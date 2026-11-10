import {writeFileSync,readFileSync} from 'node:fs';
const root=process.cwd();
const pages=await (await fetch('http://127.0.0.1:19341/json')).json();
const ws=new WebSocket(pages.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let seq=0;const waiting=new Map();ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.id){waiting.get(d.id)?.(d);waiting.delete(d.id)}};
async function call(method,params={}){const id=++seq;const p=new Promise(r=>waiting.set(id,r));ws.send(JSON.stringify({id,method,params}));const d=await p;if(d.error)throw Error(JSON.stringify(d.error));return d.result}
async function js(expression){return (await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value}
await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1520,deviceScaleFactor:1,mobile:false});
await call('Page.navigate',{url:'file://'+root+'/page/index.html'});
await new Promise(r=>setTimeout(r,600));
const evidence={};
for(const theme of ['dark','light']){
 await js(`document.documentElement.dataset.theme='${theme}'`);
 evidence[theme]=await js(`(()=>{const s=getComputedStyle(document.documentElement);return {theme:document.documentElement.dataset.theme,tokens:Object.fromEntries(['bg','surface','text','sub','ink','soft','violet','magenta','error'].map(k=>[k,s.getPropertyValue('--'+k).trim()])),body:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(root+'/brand/evidence/page-'+theme+'.png',Buffer.from(shot.data,'base64'));
}
await js(`document.querySelector('#input').value='invalid';document.querySelector('#analyze').click()`);evidence.invalid=await js(`document.querySelector('#error').textContent`);
await js(`document.querySelector('#clear').click()`);evidence.clear=await js(`document.querySelector('#input').value===''`);
await call('Emulation.setDeviceMetricsOverride',{width:390,height:1600,deviceScaleFactor:1,mobile:true});evidence.mobileOverflow=await js('document.documentElement.scrollWidth>innerWidth');
const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(root+'/brand/evidence/page-mobile.png',Buffer.from(shot.data,'base64'));
const icon='data:image/svg+xml;base64,'+Buffer.from(readFileSync(root+'/page/icon.svg')).toString('base64');
await call('Emulation.setDeviceMetricsOverride',{width:960,height:540,deviceScaleFactor:1,mobile:false});
await js(`document.body.innerHTML=${JSON.stringify(['#0e0e0e','#fafafa'].map(bg=>`<section style="background:${bg};color:${bg==='#fafafa'?'#19162e':'#eef0ff'};padding:28px;height:250px"><p>Sidebar ${bg} · 16 / 32 / 64 / 128 px</p><div style="display:flex;gap:40px;align-items:center">${[16,32,64,128].map(n=>`<img src="${icon}" width="${n}" height="${n}">`).join('')}</div></section>`).join(''))}`);
await js('Promise.all([...document.images].map(i=>i.decode()))');
const icons=await call('Page.captureScreenshot',{format:'png'});writeFileSync(root+'/brand/evidence/icons.png',Buffer.from(icons.data,'base64'));
function luminance(hex){const a=hex.match(/[0-9a-f]{2}/ig).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return a[0]*.2126+a[1]*.7152+a[2]*.0722}
evidence.contrast=[];for(const theme of ['dark','light']){const t=evidence[theme].tokens;for(const fg of ['text','sub','ink','violet','magenta','error'])for(const bg of ['bg','surface','soft']){const a=luminance(t[fg]),b=luminance(t[bg]);const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);evidence.contrast.push({theme,fg,bg,ratio:+ratio.toFixed(2),pass:ratio>=4.5})}}
writeFileSync(root+'/brand/evidence/verification.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({contrastMin:Math.min(...evidence.contrast.map(x=>x.ratio)),contrastFailures:evidence.contrast.filter(x=>!x.pass),invalid:evidence.invalid,clear:evidence.clear,mobileOverflow:evidence.mobileOverflow},null,2));
ws.close();
