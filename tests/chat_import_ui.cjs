// Real assist module, controlled files/requests/DOM; no actual credentials or model.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this._value='';this.files=[];this.checked=false;this.hidden=false;this.disabled=false;this.listeners={};this.attrs={};this.textContent='';this.className='';}
  get value(){return this._value} set value(v){this._value=v;if(this.type==='file'&&v==='')this.files=[];}
  get options(){return this.children}
  append(...nodes){nodes.forEach(n=>{this.children.push(n);n.parent=this;});}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);if(this.tagName==='select')this.value=this.children[0]?.value||'';}
  add(node){this.append(node);if(this.children.length===1)this.value=node.value;}
  setAttribute(k,v){this.attrs[k]=String(v)} removeAttribute(k){delete this.attrs[k];if(k==='value')this._value=undefined;}
  addEventListener(name,fn){this.listeners[name]=fn;}
  fire(name){return this.listeners[name]?.({target:this});}
  querySelectorAll(selector){const matches=n=>selector.split(',').some(s=>s.trim().startsWith('.')?n.className.split(' ').includes(s.trim().slice(1)):n.tagName===s.trim());return this.children.flatMap(n=>[...(matches(n)?[n]:[]),...n.querySelectorAll(selector)]);}
}
const flush=async()=>{await new Promise(setImmediate);};
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}};
const base={job_id:'import1',shop_id:'a',shop_version:3};
function result(count=45){return {pairs:Array.from({length:count},(_,i)=>({id:'p'+(i+1),conversation:'c'+i,question:'问题'+i,answer:'答复'+i,count:2,conversations:['c'+i,'c'+(i+100)]})),stats:{messages:count*4,eligible:count*2,duplicates:count,unique:count},warnings:[]};}
function snapshot(value={}){return {...base,status:'completed',phase:'completed',processed_messages:180,total_messages:180,processed_batches:1,total_batches:1,result:result(),...value};}
function fixture(handler){
 const ids={},calls=[],timers=[],readers=[];let applied=0,edited=0;
 const document={getElementById:id=>ids[id]??=new Element(),createElement:tag=>new Element(tag)};
 class FileReader {
  constructor(){readers.push(this);this.readyState=0;}
  readAsArrayBuffer(file){this.readyState=1;if(file.auto!==false)Promise.resolve().then(()=>{if(this.readyState!==1)return;this.onprogress?.({loaded:file.size,total:file.size,lengthComputable:true});this.result=new TextEncoder().encode(file.text||'[]').buffer;this.readyState=2;this.onload();});}
  abort(){if(this.readyState===1){this.readyState=2;this.onabort?.();}}
 }
 class Option extends Element{constructor(text,value){super('option');this.textContent=text;this.value=value;}}
 const state={epoch:0,token:'synthetic-token',selectedShopId:'a',formVersion:3,remoteSettings:{version:3},formDisabled:false,rules:[],shops:[{shop_id:'a',name:'虚构甲店'},{shop_id:'b',name:'虚构乙店'}],model:{dirty:false,loaded:false}};
 const request=async(url,options={})=>{calls.push({url,...options});if(options.method==='DELETE')return {status:'cancelled'};if(url==='/api/v1/admin/model')return {version:7,primary:{base_url:'http://127.0.0.1:9/v1',model:'synthetic'}};return handler(url,options);};
 const context={window:{},document,FileReader,TextDecoder,console,Option,setTimeout:(fn,ms)=>{assert.equal(ms,200);timers.push(fn);},clearTimeout(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/static/assist.js'),'utf8'),context);
 const assist=context.window.setupAdminAssist({state,request,onEdit:()=>edited++,renderRules(){},newRuleId:()=> 'new',nextUid:()=>1,validateRules:()=>({ok:true,value:[]}),handleError(){},onApply:()=>applied++});
 document.getElementById('chat-file').type='file';
 function select(file={name:'synthetic.json',size:100,text:'[]'}){ids['chat-file'].files=[file];ids['chat-file'].fire('change');}
 return {ids,state,calls,timers,readers,assist,select,applied:()=>applied,edited:()=>edited};
}
let checks=0;
async function importDone(f){f.select();await f.ids['chat-import'].fire('click');assert.equal(f.ids['chat-preview'].hidden,false);}
(async()=>{
 {
  const gate=deferred();let gets=0;
  const f=fixture(async(url,o)=>o.method==='POST'?base:(++gets===1?snapshot({status:'running',processed_messages:1000,total_messages:46846,processed_batches:1,total_batches:47,result:undefined}):gate.promise));
  f.select();const pending=f.ids['chat-import'].fire('click');await flush();
  assert.equal(f.ids['chat-import-progress'].value,1000);assert.equal(f.ids['chat-import-progress'].max,46846);
  assert.match(f.ids['chat-status'].textContent,/1000 \/ 46846/);assert.equal(f.timers.length,1);
  f.timers.shift()();await flush();gate.resolve(snapshot());await pending;
  assert.match(f.ids['chat-status'].textContent,/合并 45 组重复后保留 45 组/);checks++;
  const rows=f.ids['chat-pairs'].querySelectorAll('.assist-source');assert.equal(rows.length,20);
  const next=f.ids['chat-pairs'].querySelectorAll('button')[1];next.fire('click');assert.match(f.ids['chat-pairs'].querySelectorAll('.assist-source')[0].textContent,/p21/);next.fire('click');assert.equal(f.ids['chat-pairs'].querySelectorAll('.assist-source').length,5);checks++;
  assert(!f.calls.some(c=>c.url.includes('rule-draft')));assert.equal(f.ids['rules-generate'].disabled,true);checks++;
  assert.match(f.ids['chat-analysis-plan'].textContent,/全部 45 组独立问答，预计 1 批/);assert.match(f.ids['chat-analysis-plan'].textContent,/备用模型/);checks++;
 }
 {
  const f=fixture(async(url,o)=>o.method==='POST'?base:snapshot());
  f.select({name:'test.json',size:100,auto:false});const pending=f.ids['chat-import'].fire('click');
  f.readers[0].onprogress({loaded:37,total:100,lengthComputable:true});
  assert.equal(f.ids['chat-import-progress'].value,37);assert.equal(f.ids['chat-import-progress'].max,100);
  f.assist.reset();await pending;assert.equal(f.calls.length,0);assert.equal(f.ids['chat-preview'].hidden,true);checks++;
 }
 {
  const gate=deferred();const f=fixture(async(url,o)=>o.method==='POST'?base:gate.promise);
  f.select();const pending=f.ids['chat-import'].fire('click');await flush();
  assert.equal(f.ids['chat-import-progress'].value,undefined);checks++;
  f.state.selectedShopId='b';f.assist.sync();gate.resolve(snapshot());await pending;
  assert.equal(f.ids['chat-preview'].hidden,true);assert.equal(f.ids['chat-shop-name'].textContent,'虚构乙店');
  const deletes=f.calls.filter(c=>c.method==='DELETE');assert.equal(deletes.length,1);assert.equal(deletes[0].token,'synthetic-token');checks++;
 }
 {
  const gate=deferred();const f=fixture(async(url,o)=>gate.promise);
  f.select();const pending=f.ids['chat-import'].fire('click');await flush();
  f.assist.reset();gate.resolve(base);await pending;assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);assert.equal(f.ids['chat-preview'].hidden,true);checks++;
 }
 {
  let ruleGets=0;const rules={job_id:'rules1',shop_id:'a',shop_version:3,version:7};
  const candidate={contains:'清洁',description:'方法',reply:'使用软布',evidence_ids:['p1'],count:2,conflicts:[],warnings:[]};
  const f=fixture(async(url,o)=>{
   if(url==='/api/v1/admin/chat-import/jobs')return base;
   if(url==='/api/v1/admin/chat-import/jobs/import1')return snapshot();
   if(url==='/api/v1/admin/rule-draft/jobs'){assert.equal(o.body.import_job_id,'import1');assert(!('pairs' in o.body));return rules;}
   if(url==='/api/v1/admin/rule-draft/jobs/rules1')return {...rules,status:++ruleGets===1?'running':'completed',processed_pairs:ruleGets===1?20:45,total_pairs:45,processed_batches:ruleGets===1?1:3,total_batches:3,failed_batches:0,result:{candidates:[candidate],warnings:[]}};
   throw Error('unexpected route');
  });
  await importDone(f);f.ids['chat-confirm'].checked=true;f.ids['chat-confirm'].fire('change');
  const pending=f.ids['rules-generate'].fire('click');await flush();assert.match(f.ids['rule-draft-status'].textContent,/20 \/ 45/);assert.equal(f.ids['chat-analysis-progress'].value,20);checks++;
  f.timers.shift()();await pending;
  assert.equal(f.ids['rule-candidates'].children.length,1);
  const select=f.ids['rule-candidates'].querySelectorAll('select')[0];assert.equal(select.value,'skip');select.value='add';select.fire('change');f.ids['rules-apply'].fire('click');
  assert.equal(f.applied(),1);assert.equal(f.edited(),1);assert.equal(f.state.rules.length,1);assert(!f.calls.some(c=>c.method==='PUT'));checks++;
 }
 {
  const gate=deferred();const f=fixture(async(url,o)=>{
   if(url.startsWith('/api/v1/admin/chat-import/jobs'))return o.method==='POST'?base:snapshot();
   return gate.promise;
  });
  await importDone(f);f.ids['chat-confirm'].checked=true;f.ids['chat-confirm'].fire('change');const pending=f.ids['rules-generate'].fire('click');await flush();
  f.state.token=null;f.state.epoch++;f.assist.sync();gate.resolve({job_id:'rules-late',shop_id:'a',shop_version:3,version:7});await pending;
  assert.equal(f.ids['rule-candidates'].children.length,0);assert(f.calls.some(c=>c.method==='DELETE'&&c.url.endsWith('/rules-late')&&c.token==='synthetic-token'));checks++;
 }
 {
  const f=fixture(()=>{throw Error('no upload')});f.select({name:'big.json',size:10*1024*1024+1});await f.ids['chat-import'].fire('click');assert.equal(f.calls.length,0);assert.match(f.ids['chat-status'].textContent,/10 MB/);checks++;
 }
 {
  const data=result(51);data.pairs.forEach(p=>{p.question='😀'.repeat(500);p.answer='答'.repeat(1000);});
  const f=fixture(async(url,o)=>o.method==='POST'?base:snapshot({result:data}));
  await importDone(f);assert.match(f.ids['chat-analysis-plan'].textContent,/51 组独立问答，预计 4 批/);assert(!f.calls.some(c=>c.url.includes('rule-draft')));checks++;
 }
 {
  const html=fs.readFileSync(path.join(__dirname,'../backend/static/index.html'),'utf8');
  const scriptPage=html.slice(html.indexOf('<section id="page-scripts"'),html.indexOf('<section id="page-chat-import"'));
  assert(!scriptPage.includes('id="chat-file"'));assert(html.includes('data-route="chat-import"'));assert(html.includes('id="page-system"'));assert(html.includes('id="page-model"'));
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);checks++;
 }
 console.log(JSON.stringify({passed:checks,realAssistModule:true,fictionalDOM:true,network:false,model:false}));
})().catch(e=>{console.error(e);process.exitCode=1;});
