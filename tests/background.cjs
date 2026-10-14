const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../background.js'), 'utf8');
const registry = fs.readFileSync(require('node:path').join(__dirname, '../google-apps.js'), 'utf8');
function fixture(kind = 'dom', options = {}) {
  const data = {}, events = {}, calls = [], broadcasts = [];
  const app = options.app || ({'google-docs':'docs','google-sheets':'sheets','google-slides':'slides','google-field':'gmail'}[kind] || null);
  const urls = {docs:'https://docs.google.com/document/d/test/edit',sheets:'https://docs.google.com/spreadsheets/d/test/edit',slides:'https://docs.google.com/presentation/d/test/edit',gmail:'https://mail.google.com/mail/u/0',forms:'https://docs.google.com/forms/d/test/edit',keep:'https://keep.google.com',drive:'https://drive.google.com/drive/u/0'};
  const tab = { id: 7, url: urls[app] || 'https://example.org' };
  const event = name => ({ addListener: fn => events[name] = fn });
  const state = { granted: true, failAttach: false, failStart: false, immediateFinal: false, afterCount: 0 };
  const chrome = {
    runtime: { id: 'test-extension', onMessage: event('message'), sendMessage: async message => broadcasts.push(message),getPlatformInfo:async()=>({os:options.os||'win'}) },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    action: { onClicked: event('action') },
    storage: { session: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key] && structuredClone(data[key])])),
      set: async values => Object.assign(data, structuredClone(values)),
      remove: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(key => delete data[key])
    } },
    scripting: { executeScript: async () => {} },
    tabs: {
      query: async () => [tab], get: async () => tab, onUpdated: event('updated'), onRemoved: event('removed'),
      sendMessage: async (id, message, route) => {
        calls.push({ type: 'message', id, message, route });
        if (message.type === 'HT_FOCUS') return { ok: true, kind };
        if (message.type === 'HT_NATIVE_BEGIN') return { ok:true,kind,enterEdit:options.enterEdit===true };
        if (message.type === 'HT_NATIVE_BEFORE' && options.preflightError) return {ok:false,error:'网页输入框自身的长度上限已达到。'};
        if (message.type === 'HT_NATIVE_AFTER' && ++state.afterCount === options.failAfterAt) return {ok:false,error:'目标回执失败'};
        if (message.type === 'HT_DOM_START') {
          if (state.failStart) return { ok: false, error: '目标失效' };
          if (state.immediateFinal) await api.handle({type:'HT_DOM_PROGRESS',runId:message.runId,running:false,completed:1,total:1}, {tab,documentId:'doc-1'});
        }
        return { ok: true };
      }
    },
    permissions: { contains: async () => state.granted },
    debugger: {
      attach: async (...args) => { calls.push({type:'attach',args}); if(state.failAttach) throw Error('occupied'); },
      detach: async (...args) => calls.push({type:'detach',args}),
      sendCommand: async (target,method,params) => {
        calls.push({type:'command',target,method,params});
        if(options.failBackspaceUp && params?.key==='Backspace' && params.type==='keyUp')throw Error('keyUp failed');
      },
      onDetach: event('detach')
    }
  };
  if (options.noDebugger) delete chrome.debugger;
  if (options.noDetachEvent) delete chrome.debugger.onDetach;
  const randomMath=Object.create(Math);if(options.random!==undefined)randomMath.random=()=>options.random;
  const context=vm.createContext({chrome,crypto:webcrypto,setTimeout,clearTimeout,console,URL,Math:randomMath,importScripts(){}});
  vm.runInContext(registry+'\n'+fs.readFileSync(require('node:path').join(__dirname,'../typing-behavior.js'),'utf8')+'\n'+source+'\nglobalThis.api={handle,nativeRuns};',context);
  const api=context.api;
  data['ht.target.7']={protocol:5,targetId:'target-1',tabId:7,frameId:2,documentId:'doc-1',kind,app,multiline:options.multiline!==false,label:'test'};
  const send=message=>api.handle(message,{id:chrome.runtime.id});
  async function final() {
    const began=Date.now();
    while(Date.now()-began<3000){if(data['ht.run.7']?.running===false)return data['ht.run.7'];await new Promise(r=>setTimeout(r,5));}
    throw Error('completion timeout');
  }
  return {api,data,events,calls,broadcasts,state,send,final,tab};
}
(async()=>{
  const results=[];
  async function test(name,fn){await fn();results.push(name);console.log('PASS '+name);}
  await test('DOM final arriving before Start response is retained',async()=>{
    const f=fixture();f.state.immediateFinal=true;await f.send({type:'HT_START',tabId:7,text:'A'});
    assert.equal(f.data['ht.run.7'].running,false);
    const route=f.calls.find(c=>c.type==='message').route;assert.equal(route.documentId,'doc-1');assert.equal(route.frameId,undefined);
  });
  await test('DOM rejected Start clears running state',async()=>{
    const f=fixture();f.state.failStart=true;await assert.rejects(f.send({type:'HT_START',tabId:7,text:'A'}));assert.equal(f.data['ht.run.7'],undefined);
  });
  await test('Docs missing required permission never attaches',async()=>{
    const f=fixture('google-docs');f.state.granted=false;await assert.rejects(f.send({type:'HT_START',tabId:7,text:'A'}));assert.equal(f.calls.length,0);
  });
  await test('Missing debugger API does not crash service worker startup',async()=>{
    const f=fixture('google-docs',{noDebugger:true});
    const state=await f.send({type:'HT_STATE'});assert.equal(state.ok,true);
    await assert.rejects(f.send({type:'HT_START',tabId:7,text:'A'}),/权限不可用/);assert.equal(f.calls.length,0);
  });
  await test('Normal webpage input still starts when debugger API is unavailable',async()=>{
    const f=fixture('dom',{noDebugger:true});f.state.immediateFinal=true;
    await f.send({type:'HT_START',tabId:7,text:'A'});assert.equal(f.data['ht.run.7'].running,false);
  });
  await test('Manifest declares debugger as required and panel never requests it optionally',async()=>{
    const root=require('node:path').join(__dirname,'..');
    const manifest=JSON.parse(fs.readFileSync(require('node:path').join(root,'manifest.json'),'utf8'));
    assert.equal(manifest.version,'1.5.0');assert.ok(manifest.permissions.includes('debugger'));
    assert.ok(!manifest.optional_permissions?.includes('debugger'));
    assert.ok(!fs.readFileSync(require('node:path').join(root,'sidepanel.js'),'utf8').includes('permissions.request'));
  });
  await test('Health response reports the actual running background version',async()=>{
    const f=fixture();const state=await f.send({type:'HT_HEALTH'});assert.equal(state.version,'1.5.0');assert.equal(state.debuggerAvailable,true);
    const missing=fixture('dom',{noDebugger:true});assert.equal((await missing.send({type:'HT_HEALTH'})).debuggerAvailable,false);
  });
  await test('Missing onDetach event does not crash startup',async()=>{
    const f=fixture('google-docs',{noDetachEvent:true});assert.equal((await f.send({type:'HT_HEALTH'})).debuggerAvailable,false);
    assert.equal((await f.send({type:'HT_STATE'})).ok,true);
    await assert.rejects(f.send({type:'HT_START',tabId:7,text:'A'}),/权限不可用/);
  });
  await test('Docs Chinese/newline/tab input restores focus and detaches',async()=>{
    const f=fixture('google-docs');await f.send({type:'HT_START',tabId:7,text:'中\r\n\t文',speed:100});const state=await f.final();assert.equal(state.completed,4);
    assert.equal(f.calls.filter(c=>c.type==='attach').length,1);assert.equal(f.calls.filter(c=>c.type==='detach').length,1);
    assert.deepEqual(f.calls.filter(c=>c.method==='Input.insertText').map(c=>c.params.text),['中','    ','文']);
    assert.deepEqual(f.calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.params.type),['rawKeyDown','keyUp']);
    assert.equal(f.calls.filter(c=>c.message?.type==='HT_FOCUS').length,4);assert.equal(f.api.nativeRuns.size,0);
  });
  await test('Docs Stop wakes delay and detaches',async()=>{
    const f=fixture('google-docs');await f.send({type:'HT_START',tabId:7,text:'abcdef',speed:0});
    while(!f.calls.some(c=>c.method==='Input.insertText'))await new Promise(r=>setTimeout(r,2));
    await f.send({type:'HT_STOP',tabId:7});const state=await f.final();assert.equal(state.stopped,true);assert.equal(state.completed,1);assert.equal(f.calls.filter(c=>c.type==='detach').length,1);
  });
  await test('Docs debugger conflict produces actionable error',async()=>{
    const f=fixture('google-docs');f.state.failAttach=true;await assert.rejects(f.send({type:'HT_START',tabId:7,text:'A'}),/开发者工具/);assert.equal(f.api.nativeRuns.size,0);assert.equal(f.calls.filter(c=>c.type==='detach').length,0);
  });
  await test('Unexpected debugger detach stops typing',async()=>{
    const f=fixture('google-docs');await f.send({type:'HT_START',tabId:7,text:'abc',speed:0});f.events.detach({tabId:7},'canceled_by_user');const state=await f.final();assert.equal(state.stopped,true);assert.match(state.error,/断开/);
  });
  await test('Changing active tab refuses stale target',async()=>{
    const f=fixture();await assert.rejects(f.send({type:'HT_START',tabId:8,text:'A'}),/已切换/);
  });
  await test('Sheets begins editing before input and newline stays inside the cell',async()=>{
    const f=fixture('google-sheets',{enterEdit:true});await f.send({type:'HT_START',tabId:7,text:'中\n文',speed:100});await f.final();
    const keys=f.calls.filter(c=>c.method==='Input.dispatchKeyEvent');
    assert.deepEqual(keys.filter(c=>c.params.type!=='char').map(c=>c.params.modifiers),[0,0,2,2]);
    assert.deepEqual(keys.filter(c=>c.params.type==='char').map(c=>c.params.text),['中','文']);
    assert.equal(f.calls.filter(c=>c.method==='Input.insertText').length,0);
    assert.equal(f.calls.filter(c=>c.message?.type==='HT_NATIVE_END').length,1);
  });
  await test('Mac Sheets uses Command+Enter for in-cell newline',async()=>{
    const f=fixture('google-sheets',{os:'mac'});await f.send({type:'HT_START',tabId:7,text:'\n',speed:100});await f.final();
    assert.deepEqual(f.calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>c.params.modifiers),[4,4]);
  });
  await test('Slides uses trusted char events including separate tab spaces',async()=>{
    const f=fixture('google-slides');await f.send({type:'HT_START',tabId:7,text:'中\tA',speed:100});await f.final();
    assert.equal(f.calls.filter(c=>c.method==='Input.insertText').length,0);
    assert.deepEqual(f.calls.filter(c=>c.params?.type==='char').map(c=>c.params.text),['中',' ',' ',' ',' ','A']);
  });
  await test('Gmail Forms Keep Drive fields use native input without submit commands',async()=>{
    for(const app of ['gmail','forms','keep','drive']){
      const f=fixture('google-field',{app});await f.send({type:'HT_START',tabId:7,text:'中文',speed:100});await f.final();
      assert.equal(f.calls.filter(c=>c.method==='Input.insertText').length,2);
      assert.equal(f.calls.filter(c=>c.method==='Input.dispatchKeyEvent').length,0);
      assert.equal(f.calls.filter(c=>c.type==='detach').length,1);
    }
  });
  await test('Single-line fields reject newline before creating any debugger connection',async()=>{
    const f=fixture('google-field',{multiline:false});await assert.rejects(f.send({type:'HT_START',tabId:7,text:'A\nB'}),/单行/);assert.equal(f.calls.length,0);
  });
  await test('Google target cannot be replayed on another app or deceptive hostname',async()=>{
    const f=fixture('google-sheets');f.tab.url='https://docs.google.com/presentation/d/test/edit';await assert.rejects(f.send({type:'HT_START',tabId:7,text:'A'}),/已切换/);
    f.tab.url='https://docs.google.com.example.org/spreadsheets/d/test/edit';await assert.rejects(f.send({type:'HT_START',tabId:7,text:'A'}),/已切换/);
  });
  await test('Re-selecting a page target interrupts native typing and releases the lock',async()=>{
    const f=fixture('google-field');const started=await f.send({type:'HT_START',tabId:7,text:'abcdef',speed:0});
    while(!f.calls.some(c=>c.method==='Input.insertText'))await new Promise(r=>setTimeout(r,2));
    await f.api.handle({type:'HT_NATIVE_CANCEL',runId:started.runId},{tab:f.tab});const state=await f.final();
    assert.equal(state.stopped,true);assert.match(state.error,/位置被改变/);assert.equal(f.calls.filter(c=>c.message?.type==='HT_NATIVE_END').length,1);
  });
  await test('Native progress is published for every committed character',async()=>{
    const f=fixture('google-docs');await f.send({type:'HT_START',tabId:7,text:'中文A',speed:100});await f.final();
    assert.deepEqual(f.broadcasts.filter(m=>m.type==='HT_PROGRESS'&&m.running).map(m=>m.completed),[0,1,2,3]);
  });
  await test('Pause freezes native input and resume finishes without repeating text',async()=>{
    const f=fixture('google-docs');const started=await f.send({type:'HT_START',tabId:7,text:'中文',speed:0});
    while(f.data['ht.run.7']?.completed!==1)await new Promise(r=>setTimeout(r,2));
    const result=await f.send({type:'HT_PAUSE',tabId:7,runId:started.runId,paused:true});assert.equal(result.paused,true);
    await new Promise(r=>setTimeout(r,30));assert.equal(f.calls.filter(c=>c.method==='Input.insertText').length,1);assert.equal(f.data['ht.run.7'].paused,true);
    await f.send({type:'HT_PAUSE',tabId:7,runId:started.runId,paused:false});const state=await f.final();
    assert.equal(state.completed,2);assert.equal(state.paused,false);assert.deepEqual(f.calls.filter(c=>c.method==='Input.insertText').map(c=>c.params.text),['中','文']);
  });
  await test('Stop while paused wakes the task and releases its connection',async()=>{
    const f=fixture('google-docs');const started=await f.send({type:'HT_START',tabId:7,text:'中文',speed:0});
    while(f.data['ht.run.7']?.completed!==1)await new Promise(r=>setTimeout(r,2));
    await f.send({type:'HT_PAUSE',tabId:7,runId:started.runId,paused:true});await f.send({type:'HT_STOP',tabId:7});const state=await f.final();
    assert.equal(state.stopped,true);assert.equal(state.completed,1);assert.equal(state.paused,false);assert.equal(f.calls.filter(c=>c.type==='detach').length,1);
  });
  await test('Chinese human input inserts a random English letter, deletes it, then types the draft character',async()=>{
    const f=fixture('google-docs',{random:0});await f.send({type:'HT_START',tabId:7,text:'中',speed:100,humanMode:true});const state=await f.final();
    assert.deepEqual(f.calls.filter(c=>c.method==='Input.insertText').map(c=>c.params.text),['a','中']);
    assert.equal(f.calls.filter(c=>c.params?.key==='Backspace').length,2);assert.equal(state.completed,1);
  });
  await test('Stop during a typo removes the temporary English letter',async()=>{
    const f=fixture('google-docs',{random:0});await f.send({type:'HT_START',tabId:7,text:'中',speed:100,humanMode:true});
    while(!f.api.nativeRuns.get(7)?.pendingTypo)await new Promise(r=>setTimeout(r,2));
    await f.send({type:'HT_STOP',tabId:7});const state=await f.final();assert.equal(state.completed,0);
    assert.equal(f.calls.filter(c=>c.params?.key==='Backspace').length,2);assert.equal(f.calls.filter(c=>c.method==='Input.insertText').length,1);
  });
  await test('Out-of-order DOM progress cannot rewind the count or paused state',async()=>{
    const f=fixture();const started=await f.send({type:'HT_START',tabId:7,text:'中文'});
    await f.api.handle({type:'HT_DOM_PROGRESS',runId:started.runId,sequence:3,running:true,paused:true,completed:1,total:2},{tab:f.tab});
    await f.api.handle({type:'HT_DOM_PROGRESS',runId:started.runId,sequence:2,running:true,paused:false,completed:0,total:2},{tab:f.tab});
    assert.equal(f.data['ht.run.7'].completed,1);assert.equal(f.data['ht.run.7'].paused,true);
  });
  await test('Ordinary page pause is routed to its current content task',async()=>{
    const f=fixture();const started=await f.send({type:'HT_START',tabId:7,text:'中文'});await f.send({type:'HT_PAUSE',tabId:7,runId:started.runId,paused:true});
    const command=f.calls.find(c=>c.message?.type==='HT_DOM_PAUSE');assert.equal(command.message.runId,started.runId);assert.equal(command.message.paused,true);
  });
  await test('Rejected temporary letter never sends Backspace against existing field text',async()=>{
    const f=fixture('google-field',{random:0,preflightError:true});await f.send({type:'HT_START',tabId:7,text:'中',humanMode:true,speed:100});const state=await f.final();
    assert.equal(state.completed,0);assert.match(state.error,/长度上限/);assert.equal(f.calls.filter(c=>c.method?.startsWith('Input.')).length,0);
  });
  await test('Concurrent native Start creates only one live input connection',async()=>{
    const f=fixture('google-docs');const results=await Promise.allSettled([f.send({type:'HT_START',tabId:7,text:'中'}),f.send({type:'HT_START',tabId:7,text:'文'})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await f.final();assert.equal(f.calls.filter(c=>c.type==='attach').length,1);
  });
  await test('Concurrent DOM Start cannot remove the successful task state',async()=>{
    const f=fixture();const results=await Promise.allSettled([f.send({type:'HT_START',tabId:7,text:'中'}),f.send({type:'HT_START',tabId:7,text:'文'})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.data['ht.run.7'].running,true);
    assert.equal(f.calls.filter(c=>c.message?.type==='HT_DOM_START').length,1);
  });
  await test('Temporary letter is cleaned up even when its post-input acknowledgement fails',async()=>{
    const f=fixture('google-docs',{random:0,failAfterAt:1});await f.send({type:'HT_START',tabId:7,text:'中',humanMode:true,speed:100});const result=await f.final();
    assert.equal(result.completed,0);assert.equal(f.calls.filter(c=>c.params?.key==='Backspace').length,2);
  });
  await test('Correction acknowledgement failure cannot delete a second character',async()=>{
    const f=fixture('google-docs',{random:0,failAfterAt:2});await f.send({type:'HT_START',tabId:7,text:'中',humanMode:true,speed:100});const result=await f.final();
    assert.equal(result.completed,0);assert.equal(f.calls.filter(c=>c.params?.key==='Backspace').length,2);
  });
  await test('Correction key-up failure cannot trigger another Backspace',async()=>{
    const f=fixture('google-docs',{random:0,failBackspaceUp:true});await f.send({type:'HT_START',tabId:7,text:'中',humanMode:true,speed:100});await f.final();
    assert.equal(f.calls.filter(c=>c.params?.key==='Backspace').length,2);
  });
  console.log(results.length+' / '+results.length+' passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
