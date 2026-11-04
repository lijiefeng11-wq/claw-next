import assert from "node:assert/strict";
import Module from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";

const req=Module.createRequire(__filename),electronPath=req.resolve("electron");
req.cache[electronPath]={id:electronPath,filename:electronPath,loaded:true,exports:{BrowserWindow:class{},session:{fromPartition:()=>({})}}} as unknown as NodeModule;
const {PddPageAdapter}=req("../src/main/pddAdapter.js") as typeof import("../src/main/pddAdapter.js");

function fixture(change:(a:any,wc:EventEmitter)=>void){
 const adapter=new PddPageAdapter("fictional","虚构店铺",null) as any;
 const wc=Object.assign(new EventEmitter(),{getURL:()=>"https://mms.pinduoduo.com/chat-merchant/index.html",executeJavaScript:async(script:string)=>{
  if(script.includes('const path="/chats/userinfo/realtime"'))return {mall_id:"7",mall:{mall_id:"7",mall_name:"虚构店铺"}};
  if(script.includes('const path="/latitude/goods/queryGoods"'))return {goods:[{goodsId:"123",goodsName:"虚构商品"}],total:1};
  if(script.includes('const path="/latitude/goods/goodsProperties"')){change(adapter,wc);return {properties:[]};}
  return {sku:[]};
 }});
 adapter.window={isDestroyed:()=>false,webContents:wc};adapter.status=()=>({logged_in:true,identity:{platform_shop_id:"7"}});
 return {adapter,wc};
}

test("actual product adapter: resize/popup epoch changes do not discard product learning",async()=>{
 const {adapter,wc}=fixture(a=>{a.watchEpoch+=2;});let uploads=0;
 const result=await adapter.collectProducts({},async()=>{uploads++;},()=>{});
 assert.deepEqual(result,{total:1,complete:true});assert.equal(uploads,1);
 for(const event of ["did-start-loading","did-navigate","render-process-gone","destroyed"])assert.equal(wc.listenerCount(event),0);
});
for(const event of ["did-start-loading","did-navigate","render-process-gone","destroyed"]){
 test(`actual product adapter: ${event} during a read latches invalidation and removes listeners`,async()=>{
  const {adapter,wc}=fixture((_a,w)=>w.emit(event));let uploads=0;
  await assert.rejects(adapter.collectProducts({},async()=>{uploads++;},()=>{}),/product_source_changed/);
  assert.equal(uploads,0);for(const e of ["did-start-loading","did-navigate","render-process-gone","destroyed"])assert.equal(wc.listenerCount(e),0);
 });
}
for(const change of [(a:any)=>{a.window={isDestroyed:()=>false};},(a:any)=>{a.status=()=>({logged_in:false,identity:{platform_shop_id:"7"}});},(a:any)=>{a.status=()=>({logged_in:true,identity:{platform_shop_id:"8"}});}]){
 test("actual product adapter: replaced page, lost login or other shop cannot publish",async()=>{
  const {adapter}=fixture(change);await assert.rejects(adapter.collectProducts({},async()=>{throw Error("unexpected upload");},()=>{}),/product_source_changed/);
 });
}

test("actual product adapter: navigation while the final batch is classified cannot finalize knowledge",async()=>{
 const {adapter,wc}=fixture(()=>{});let staged=0;
 await assert.rejects(adapter.collectProducts({},async()=>{staged++;wc.emit("did-navigate");},()=>{}),/product_source_changed/);
 assert.equal(staged,1);assert.equal(wc.listenerCount("did-navigate"),0);
});
