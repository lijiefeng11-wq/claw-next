// Actual discovery, page scripts and send engine; fictional DOM/receipt only. No platform requests.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const parentOwned=process.env.CLAW_NEXT_SEND_LOCATION_DATA;
const temp=parentOwned?path.join(parentOwned,'transfer-discovery'):fs.mkdtempSync(path.join(os.tmpdir(),'claw-discovery-fictional-'));
fs.mkdirSync(temp,{recursive:true});
app.setPath('userData',temp);
const {PddPageAdapter}=require(path.join(root,'dist/src/main/pddAdapter.js'));
const {selectSendControl,stopSelector}=require(path.join(root,'dist/src/main/scraplingSelector.js'));
const cases=[];const timer=setTimeout(()=>app.exit(2),45000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const wc=win.webContents;wc.session.webRequest.onBeforeRequest((d,c)=>c({cancel:!d.url.startsWith('data:')}));wc.debugger.attach('1.3');
 const native=wc.debugger.sendCommand.bind(wc.debugger);
 await selectSendControl('<div class="reply-footer"><button data-claw-candidate="0">发送</button></div>',15000);
 try{
  for(const header of [true,false]){
   const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}.reply-box{position:absolute;left:200px;top:250px}.send-btn{display:block;width:90px;height:35px;background:#69f}.el-dialog__wrapper{display:none;position:fixed;inset:0;background:#999c;z-index:99}.el-dialog{position:absolute;left:150px;top:80px;width:600px;height:260px;background:white}.el-dialog__headerbtn{position:absolute;right:4px;top:4px}</style>
    <li class="chat-item"><div class="chat-item-box active" data-random="9001-fixture"></div></li>
    <button id="open" onclick="opens++;document.querySelector('.el-dialog__wrapper').style.display='block'">转移会话</button>
    <div class="reply-box"><div class="reply-input"><textarea></textarea></div><div class="reply-footer"><div class="send-btn" onclick="sends++;document.querySelector('textarea').value=''">发送</div></div></div>
    <div class="el-dialog__wrapper"><div class="el-dialog"><span class="el-dialog__title">转移会话</span>${header?'<button class="el-dialog__headerbtn" onclick="closes++;document.querySelector(\'.el-dialog__wrapper\').style.display=\'none\'">X</button>':''}<table><tr class="el-table__row"><td>fictional-main</td><td>fixture</td><td><button onclick="transfers++">转移</button></td></tr></table></div></div>
    <script>window.opens=0;window.closes=0;window.sends=0;window.transfers=0;window.escapes=0;addEventListener('keydown',e=>{if(e.key==='Escape'){escapes++;document.querySelector('.el-dialog__wrapper').style.display='none'}})</script>`;
   await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
   const a=new PddPageAdapter('fictional','Fictional');a.window=win;a.tracker={status:()=>({logged_in:true,identity:{platform_shop_id:'fictional-mall'}})};a.freshActive=async()=>'9001';a.openConversation=async()=>null;
   wc.debugger.sendCommand=async(method,params={},session)=>{
    const r=await native(method,params,session);
    if(params.type==='mouseReleased'){
     const sent=await wc.executeJavaScript('window.sends');
     if(sent&&a.outgoing)a.outgoing.resolve({status:'confirmed',platform_message_id:'fictional-only'});
    }
    return r;
   };
   const targets=await a.readTransferTargets('9001',1800);
   const before=await wc.executeJavaScript("({open:getComputedStyle(document.querySelector('.el-dialog__wrapper')).display!=='none',opens,closes,escapes,transfers})");
   const send=await a.send({conversation_id:'9001',text:'fictional reply',attempt_id:'fictional-only',deadline:Date.now()/1000+10,recheck:()=>null});
   const after=await wc.executeJavaScript('({sends,transfers})');
   assert.equal(targets.length,1);assert.equal(before.open,false);assert.equal(send.status,'confirmed');assert.equal(after.sends,1);assert.equal(after.transfers,0);assert.equal(a.sending,false);
   cases.push({header_close:header,targets:targets.length,before_send:before,send,after,expected_cleaned_and_sent:!before.open&&send.status==='confirmed'&&after.sends===1&&after.transfers===0,busy_released:!a.sending});
   wc.debugger.sendCommand=native;
  }
 }finally{stopSelector();win.destroy();clearTimeout(timer);if(!parentOwned)fs.rmSync(temp,{recursive:true,force:true});}
 const result={ok:true,fictional_data_only:true,actual_adapter_scripts_and_playwright_scrapling:true,platform_receipt_stubbed:true,cases};console.log(JSON.stringify(result));app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});
