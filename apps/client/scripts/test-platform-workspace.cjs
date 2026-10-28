/** Exercise the real client shell, workspace host and CDP helper using synthetic pages only. */
const { app, BaseWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { dispatchPageClick } = require('../dist/src/main/pddClick.js');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Provide absolute output directory');
fs.mkdirSync(output, {recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'claw-workspace-accept-'));
process.env.CLAW_NEXT_USER_DATA=temp;
delete process.env.CLAW_NEXT_DEV_BACKEND_CONFIG;
delete process.env.CLAW_NEXT_PDD_PROBE;
const results=[], pages=[], owned=[];
let blocked=0, fakeDocuments=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(p,label,ms=5000){let timer;try{return await Promise.race([p,new Promise((_,r)=>{timer=setTimeout(()=>r(Error(label+'_timeout')),ms);})]);}finally{clearTimeout(timer);}}
async function until(fn,label){return bounded((async()=>{while(!await fn())await sleep(30);})(),label);}
async function js(wc,s){return bounded(wc.executeJavaScript(s),'javascript');}
const secured = new WeakSet();
function secure(s){
  if(secured.has(s))return;secured.add(s);
  s.setPermissionRequestHandler((_w,_p,cb)=>cb(false));s.setPermissionCheckHandler(()=>false);
  s.webRequest.onBeforeRequest({urls:['http://*/*','ws://*/*','wss://*/*']},(_d,cb)=>{blocked++;cb({cancel:true});});
  s.protocol.handle('https',()=>{
    const id=++fakeDocuments;
    return new Response(`<!doctype html><meta charset="utf-8"><style>body{font:20px system-ui;background:#eef5ff}button{position:absolute;left:160px;top:120px;width:120px;height:44px}p{margin-top:150px}</style><h1>虚构平台页面 ${id}</h1><button>测试计数 +1</button><p>仅验证多店页面与点击，不连接真实平台。</p><script>window.fixture={count:0,id:${id}};document.querySelector('button').onclick=()=>{window.fixture.count++;};</script>`,{headers:{'Content-Type':'text/html;charset=utf-8'}});
  });
}
app.on('session-created',secure);
app.on('web-contents-created',(_e,wc)=>owned.push(wc));
require('../dist/src/main/main.js');
app.on('before-quit',e=>e.preventDefault());
async function test(name,fn){try{results.push({name,passed:true,evidence:await fn()});}catch(e){results.push({name,passed:false,error:String(e.message).slice(0,200)});}}
let win;
async function counts(){return Promise.all(pages.map(wc=>js(wc,'window.fixture.count')));}
async function click(index){
  const wc=pages[index],before=await counts();
  const point=await js(wc,"(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  assert.equal((await dispatchPageClick(wc,point,()=>null)).status,'dispatched');
  await sleep(80);const after=await counts();
  assert.deepEqual(after,before.map((n,i)=>n+(i===index?1:0)));
  return {target:index,delta:after.map((n,i)=>n-before[i])};
}
async function invoke(ch,payload){return js(win.webContents,`window.clawNext.invoke(${JSON.stringify(ch)},${JSON.stringify(payload)})`);}
const watchdog=setTimeout(()=>{console.error('workspace_acceptance_timeout');app.exit(2);},90000);
app.whenReady().then(async()=>{
  try{
    secure(session.defaultSession);
    await until(()=>{win=BaseWindow.getAllWindows()[0];return win&&!win.webContents.isLoading()&&win.webContents.getURL().startsWith('file:');},'shell');
    for(const id of ['fixture-a','fixture-b']){
      assert.equal((await invoke('shop:save',{shop:{shop_id:id,display_name:'虚构店铺 '+id.at(-1).toUpperCase(),backend_url:'http://127.0.0.1:1',platform_shop_id:id,adapter:'pdd'}})).ok,true);
      assert.equal((await invoke('shop:login',{shop_id:id})).ok,true);
      pages.push(win.contentView.children.map(v=>v.webContents).find(wc=>wc && wc!==win.webContents && !pages.includes(wc)));
    }
    await until(()=>js(win.webContents,"document.querySelectorAll('.shop-item').length===2"),'shop_list');
    await test('real_shell_defaults_to_receive_only',async()=>{
      const state=(await invoke('state:get')).data;
      assert.ok(state.shops.every(s=>s.config.mode==='observe'&&!s.running&&!s.platform.logged_in));
      assert.equal(await js(win.webContents,"typeof require==='undefined' && typeof process==='undefined'"),true);
    });
    await test('two_isolated_attached_pages',async()=>{
      assert.equal(new Set(pages).size,2);assert.notEqual(pages[0].session,pages[1].session);
      for(const wc of pages){assert.equal(wc.getBackgroundThrottling(),false);assert.equal(await js(wc,"typeof require==='undefined' && typeof window.clawNext==='undefined'"),true);}
      assert.equal(BaseWindow.getAllWindows().length,1);
    });
    await test('sidebar_selects_embedded_page',async()=>{
      await js(win.webContents,"document.querySelectorAll('.shop-item')[0].click()");await sleep(200);
      assert.equal(win.contentView.children.at(-1).webContents,pages[0]);
      assert.equal(win.contentView.children.at(-1).getVisible(),true);
      return click(0);
    });
    await test('hidden_shop_click_has_no_focus_dependency',()=>click(1));
    await test('records_tab_hides_pages_keeps_them_attached',async()=>{
      await js(win.webContents,"[...document.querySelectorAll('button')].find(e=>e.textContent==='收发记录与设置').click()");await sleep(150);
      assert.equal(win.contentView.children.at(-1).webContents,win.webContents);
      assert.ok(win.contentView.children.filter(v=>pages.includes(v.webContents)).every(v=>v.getVisible()));
      return click(0);
    });
    await test('switch_shop_keeps_original_session',async()=>{
      await js(win.webContents,"document.querySelectorAll('.shop-item')[1].click()");await sleep(150);
      assert.equal(win.contentView.children.at(-1).webContents,pages[1]);return click(1);
    });
    await test('zoom_125_percent_css_coordinates',async()=>{pages[0].setZoomFactor(1.25);await sleep(100);try{return await click(0);}finally{pages[0].setZoomFactor(1);}});
    await test('two_shops_parallel',async()=>{
      const before=await counts();
      const pts=await Promise.all(pages.map(wc=>js(wc,"(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()")));
      assert.ok((await Promise.all(pages.map((wc,i)=>dispatchPageClick(wc,pts[i],()=>null)))).every(r=>r.status==='dispatched'));
      await sleep(80);assert.deepEqual(await counts(),before.map(n=>n+1));
    });
    await test('minimized_click',async()=>{win.minimize();await until(()=>win.isMinimized(),'minimize');try{return await click(0);}finally{win.restore();}});
    await test('detached_debugger_never_retries',async()=>{
      const before=await counts();pages[0].debugger.detach();
      assert.deepEqual(await dispatchPageClick(pages[0],{x:220,y:142},()=>null),{status:'not_sent',reason:'debugger_not_attached'});assert.deepEqual(await counts(),before);
    });
    await test('invalid_layout_ipc_rejected',async()=>{assert.equal((await invoke('workspace:present',{shop_id:'fixture-a',bounds:{x:0,y:0,width:-1,height:100}})).ok,false);});
    await test('closing_one_page_keeps_other_alive',async()=>{assert.equal((await invoke('shop:logout',{shop_id:'fixture-a'})).ok,true);await until(()=>pages[0].isDestroyed(),'page_close');assert.equal(pages[1].isDestroyed(),false);});
    fs.writeFileSync(path.join(output,'workspace-shell.png'),(await win.capturePage()).toPNG());
  }catch(e){results.push({name:'setup',passed:false,error:String(e.message).slice(0,200)});}
  finally{
    for(const w of BaseWindow.getAllWindows())if(!w.isDestroyed())w.destroy();
    for(const wc of owned)if(!wc.isDestroyed())wc.close({waitForBeforeUnload:false});
    await sleep(150);clearTimeout(watchdog);
    const report={synthetic:true,production_modules:true,real_platform:false,real_network_requests:0,synthetic_documents:fakeDocuments,blocked,electron:process.versions.electron,results,cleanup:{all_owned_contents_destroyed:owned.every(w=>w.isDestroyed())}};
    report.passed=results.every(r=>r.passed)&&report.cleanup.all_owned_contents_destroyed;
    fs.writeFileSync(path.join(output,'workspace-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
    fs.rmSync(temp,{recursive:true,force:true});app.exit(report.passed?0:1);
  }
});
