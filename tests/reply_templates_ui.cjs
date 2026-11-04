// Actual management code; fictional DOM, shops and HTTP only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class Element {
  constructor(tag) { Object.assign(this, {tagName:tag,children:[],dataset:{},value:'',textContent:'',files:[],checked:false,hidden:false,disabled:false,listeners:{},className:'',style:{},classList:{add(){},remove(){},toggle(){}}}); }
  appendChild(n) { this.children.push(n);n.parent=this;return n; }
  replaceChildren(...nodes) { this.children=[];nodes.forEach(n=>this.appendChild(n)); }
  setAttribute() {} focus() {} addEventListener(name,fn) { this.listeners[name]=fn; }
  querySelectorAll(selector) { const match=n=>selector.split(',').some(s=>s.trim().startsWith('.') ? n.className.split(' ').includes(s.trim().slice(1)) : n.tagName===s.trim());return this.children.flatMap(n=>[...(match(n)?[n]:[]),...n.querySelectorAll(selector)]); }
}
let source=fs.readFileSync(path.join(__dirname,'../backend/static/app.js'),'utf8');
source=source.replace(/  if \(document.readyState === "loading"\) \{[\s\S]*?\n  \}\n\}\)\(\);\s*$/, '  globalThis.fixture={state,el,IDS,renderSettings,createTemplate,onTemplateChange,saveSettings,onFormEdit,applyRemoteSettings,syncTemplateSelect,settingsSignature,collectRules};\n})();');
const plain=x=>JSON.parse(JSON.stringify(x));
const shared={mode:'hybrid',system_prompt:'共用提示词',rules:[{id:'r',contains:'规格',reply:'请补充车型'}]};
const tpl={template_id:'a'.repeat(32),name:'共用模板',version:3,...shared};
const local={enabled:false,mode:'rules',system_prompt:'本店旧提示词',rules:[],fallback:{error:{action:'none'}},version:11};
const response=(data,status=200)=>({ok:status<400,status,text:async()=>JSON.stringify(data)});
function setup(handler=async()=>response({})) {
  const ids={},calls=[];
  const document={createElement:t=>new Element(t),getElementById:id=>ids[id]??=new Element('div')};
  const window={confirm:()=>true,prompt:()=> '新模板'};
  const ctx={document,window,URL,Date,console,setTimeout:()=>1,clearTimeout(){},fetch:async(url,opts)=>{calls.push({url,body:opts.body?JSON.parse(opts.body):null});return handler(url,opts);}};
  vm.runInNewContext(source,ctx);const h=ctx.fixture;
  h.IDS.forEach(id=>h.el[id]=document.getElementById(id));
  Object.assign(h.state,{token:'fictional-session',selectedShopId:'a',shops:[{shop_id:'a',name:'虚构甲店',settings:plain(local)},{shop_id:'b',name:'虚构乙店',settings:plain(local)}],templates:[plain(tpl)],formDisabled:false});
  h.renderSettings(plain(local));
  return {h,ids,calls,window};
}
let passed=0;
(async()=>{
  {
    const {h,ids,calls}=setup();const fallback=plain(h.state.fallback);
    ids['template-select'].value=tpl.template_id;h.onTemplateChange();
    assert.equal(ids['prompt-input'].value,tpl.system_prompt);assert.equal(ids['mode-input'].value,'hybrid');
    assert.deepEqual(plain(h.collectRules().value),tpl.rules.map(r=>({...r,description:''})));assert.equal(ids['enabled-input'].checked,false);
    assert.deepEqual(plain(h.state.fallback),fallback);assert.equal(h.state.formVersion,11);assert.equal(h.state.templateVersion,3);
    assert.equal(h.state.formDirty,true);assert.equal(calls.length,0);passed++;
  }
  {
    const {h,ids,window}=setup();ids['prompt-input'].value='尚未保存的文字';h.onFormEdit();window.confirm=()=>false;
    ids['template-select'].value=tpl.template_id;h.onTemplateChange();
    assert.equal(ids['prompt-input'].value,'尚未保存的文字');assert.equal(h.state.templateId,'');assert.equal(ids['template-select'].value,'');passed++;
  }
  {
    const {h,ids,calls}=setup((_u,o)=>response({...JSON.parse(o.body),version:12}));
    h.renderSettings({...local,...shared,template_id:tpl.template_id,template_version:3});
    ids['template-select'].value='';h.onTemplateChange();assert.equal(ids['prompt-input'].value,shared.system_prompt);
    await h.saveSettings();assert.equal(calls[0].body.template_id,null);assert.equal(calls[0].body.template_version,undefined);
    assert.equal(calls[0].body.enabled,false);passed++;
  }
  {
    const created={...tpl,name:'新模板',version:1};
    const {h,ids,calls}=setup((url,o)=>response(url.endsWith('reply-templates')?created:{...JSON.parse(o.body),version:12}));
    await h.createTemplate();assert.equal(calls.length,1);assert.deepEqual(Object.keys(calls[0].body).sort(),['mode','name','rules','system_prompt']);
    assert.equal(h.state.shops[0].settings.template_id,undefined);assert.equal(ids['enabled-input'].checked,false);
    assert.match(ids['save-status'].textContent,/本店才会选用/);await h.saveSettings();
    assert.equal(calls[1].url,'/api/v1/admin/shops/a/settings');assert.equal(calls[1].body.template_id,tpl.template_id);assert.equal(calls[1].body.template_version,1);passed++;
  }
  {
    let done;const {h,ids}=setup(()=>new Promise(r=>{done=r;}));const pending=h.createTemplate();
    ids['prompt-input'].value='等待时继续输入';h.onFormEdit();done(response({...tpl,version:1}));await pending;
    assert.equal(ids['prompt-input'].value,'等待时继续输入');assert.equal(h.state.templateId,'');assert.equal(h.state.formDirty,true);passed++;
  }
  {
    let done;const {h}=setup(()=>new Promise(r=>{done=r;}));const pending=h.createTemplate();
    h.state.selectedShopId='b';h.renderSettings({...local,system_prompt:'乙店'});h.state.selectedShopId='a';h.renderSettings(local);
    done(response({...tpl,version:1}));await pending;assert.equal(h.state.templateId,'');assert.equal(h.state.formDirty,false);passed++;
  }
  {
    let done;const {h}=setup(()=>new Promise(r=>{done=r;}));const pending=h.createTemplate();
    h.state.epoch++;h.state.templates=[];done(response({...tpl,version:1}));await pending;assert.equal(h.state.templates.length,0);passed++;
  }
  {
    const {h,ids}=setup();h.renderSettings({...local,...shared,template_id:tpl.template_id,template_version:3});
    ids['prompt-input'].value='当前未保存编辑';h.onFormEdit();
    h.applyRemoteSettings({...local,...shared,system_prompt:'另一个店更新的模板',template_id:tpl.template_id,template_version:4,version:12});
    assert.equal(ids['prompt-input'].value,'当前未保存编辑');assert.equal(h.state.templateVersion,3);assert.equal(h.state.formVersion,11);passed++;
  }
  {
    const {h,ids}=setup(()=>response({error:{code:'template_changed',message:'template_changed'}},409));
    h.renderSettings({...local,...shared,template_id:tpl.template_id,template_version:3});ids['prompt-input'].value='陈旧的编辑';h.onFormEdit();
    await h.saveSettings();assert.equal(ids['prompt-input'].value,'陈旧的编辑');assert.match(ids['save-status'].textContent,/模板已有更新/);passed++;
  }
  {
    const {h,ids}=setup();h.state.templates=[{...tpl,name:'<img src=x onerror=alert(1)>'}];h.syncTemplateSelect();
    assert.equal(ids['template-select'].children[1].textContent,'<img src=x onerror=alert(1)>');assert.equal(ids['template-select'].children[1].children.length,0);passed++;
  }
  {
    let done;const {h,ids,calls}=setup(()=>new Promise(r=>{done=r;}));const pending=h.saveSettings();
    await h.saveSettings();assert.equal(calls.length,1);ids['prompt-input'].value='发送后继续输入';h.onFormEdit();
    done(response({...local,version:12}));await pending;assert.equal(ids['prompt-input'].value,'发送后继续输入');assert.equal(h.state.formDirty,true);passed++;
  }
  {
    const {h,ids}=setup();h.renderSettings({...local,...shared,template_id:tpl.template_id,template_version:3});
    h.applyRemoteSettings({...local,...shared,template_id:tpl.template_id,template_version:4,version:12,system_prompt:'同步的新话术'});
    assert.equal(ids['prompt-input'].value,'同步的新话术');assert.equal(h.state.templateVersion,4);assert.equal(ids['enabled-input'].checked,false);passed++;
  }
  console.log(JSON.stringify({passed,actualManagementCode:true,realHttp:false,platform:false}));
})().catch(e=>{console.error(e);process.exitCode=1;});
