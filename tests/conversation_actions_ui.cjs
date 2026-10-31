// Real management code in a tiny DOM fixture; no HTTP, Electron or platform.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Element {
  constructor(tag) { this.tagName=tag;this.children=[];this.dataset={};this.value='';this.files=[];this.checked=false;this.hidden=false;this.disabled=false;this.listeners={};this.className='';this.style={};this.classList={add(){},remove(){},toggle(){}}; }
  appendChild(node) { this.children.push(node);node.parent=this;return node; }
  replaceChildren(...nodes) { this.children=[];nodes.forEach(n=>this.appendChild(n)); }
  replaceWith(node) { const i=this.parent.children.indexOf(this);this.parent.children[i]=node;node.parent=this.parent; }
  setAttribute() {}
  focus() {}
  addEventListener(name, fn) { this.listeners[name]=fn; }
  fire(name) { this.listeners[name]?.({target:this}); }
  querySelectorAll(selector) { const match=n=>selector.split(',').some(s=>s.trim().startsWith('.') ? n.className.split(' ').includes(s.trim().slice(1)) : n.tagName===s.trim());return this.children.flatMap(n=>[...(match(n)?[n]:[]),...n.querySelectorAll(selector)]); }
}
const ids={};
const document={createElement:tag=>new Element(tag),getElementById:id=>ids[id]??=new Element('div')};
const context={document,console,setTimeout:()=>0,clearTimeout(){},window:{},sessionStorage:{},URL,Date};
let source=fs.readFileSync(path.join(__dirname,'../backend/static/app.js'),'utf8');
source=source.replace(/  if \(document.readyState === "loading"\) \{[\s\S]*?\n  \}\n\}\)\(\);\s*$/, '  globalThis.fixture={state,el,IDS,loadRules,collectRules,renderFallback,newPolicy,settingsSignature,policyError,actionBadge,deliveryBadge};\n})();');
vm.runInNewContext(source,context);
const h=context.fixture;assert.ok(h);
h.IDS.forEach(id=>h.el[id]=document.getElementById(id));
h.state.formDisabled=false;
const plain=v=>JSON.parse(JSON.stringify(v));
let checks=0;
{
  h.loadRules([{id:'r',contains:'x',reply:'old text',handling:{action:'mark',color:'orange'}}]);
  const rule=h.collectRules();assert.equal(rule.ok,true);assert.deepEqual(plain(rule.value[0].handling),{action:'mark',color:'orange'});assert.ok(!('reply' in rule.value[0]));assert.ok(!('send' in rule.value[0]));checks++;
  const select=h.el['rules-list'].querySelectorAll('.rule-send-type')[0];select.value='handling:transfer';select.fire('change');
  assert.equal(h.state.rules[0].handling.allow_unmark,true);
  const account=h.el['rules-list'].querySelectorAll('.policy-details')[0].querySelectorAll('input')[0];account.value='  虚构客服  ';account.fire('input');
  assert.equal(h.collectRules().value[0].handling.account,'虚构客服');checks++;
  select.value='';select.fire('change');assert.equal(h.collectRules().value[0].reply,'old text');assert.ok(!('handling' in h.collectRules().value[0]));checks++;
}
{
  h.renderFallback({error:{action:'transfer',account:'客服甲',allow_unmark:false}});
  assert.equal(h.state.fallback.error.allow_unmark,false);
  const first=h.el['fallback-controls'].children[0];const action=first.querySelectorAll('select')[0];action.value='mark';action.fire('change');
  const color=first.querySelectorAll('select')[1];color.value='orange';color.fire('change');assert.equal(h.state.fallback.unhandled.color,'orange');checks++;
  const before=h.settingsSignature({rules:[],fallback:plain(h.state.fallback)});
  const after=h.settingsSignature({rules:[],fallback:{error:{action:'none'}}});assert.notEqual(before,after);checks++;
  h.renderFallback({});assert.equal(h.state.fallback.error.action,'handoff');assert.ok(!JSON.stringify(h.state.fallback).includes('客服甲'));checks++;
}
{
  h.loadRules(Array.from({length:11},(_,i)=>({id:'r'+i,contains:'x',handling:{action:'mark',color:'green'}})));
  assert.equal(h.collectRules().value.length,11);h.state.rulesPage=1;h.loadRules([{id:'r',contains:'y',reply:'新店铺'}]);
  assert.equal(h.state.rulesPage,0);assert.ok(!('handling' in h.collectRules().value[0]));checks++;
  assert.equal(h.policyError({action:'transfer',account:' '}),'请填写 1–40 字的客服账号显示名。');
  assert.match(h.actionBadge('mark').textContent,/收藏/);assert.match(h.deliveryBadge('sent','transfer').textContent,/操作已确认/);checks++;
}
{
  h.loadRules([{id:'r',contains:'old',handling:{action:'mark',color:'orange'}}]);
  Object.assign(h.state,{token:'fake',selectedShopId:'a',formVersion:3,remoteSettings:{version:3}});
  const assistSource=fs.readFileSync(path.join(__dirname,'../backend/static/assist.js'),'utf8').replace('return {reset, sync};','return {reset, sync, seed(value) { draft=value; }};');
  vm.runInNewContext(assistSource,context);
  const assist=context.window.setupAdminAssist({state:h.state,request:()=>{throw Error('no HTTP');},onEdit(){},renderRules:()=>h.loadRules(h.state.rules),newRuleId:()=> 'new',nextUid:()=>1,validateRules:h.collectRules,handleError(){}});
  assist.seed({context:{epoch:0,token:'fake',shop:'a',version:3,seq:0},snapshot:JSON.stringify(h.state.rules),modelVersion:0,items:[{candidate:{},choice:{value:'replace:r'},contains:{value:'new'},description:{value:''},reply:{value:'new reply'}}]});
  document.getElementById('rules-apply').fire('click');
  const saved=h.collectRules().value[0];assert.equal(saved.reply,'new reply');assert.ok(!('handling' in saved));checks++;
}
console.log(JSON.stringify({passed:checks,realManagementFunctions:true,network:false,platform:false}));
