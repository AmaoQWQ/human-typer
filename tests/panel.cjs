const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../sidepanel.js'), 'utf8');
async function fixture(options = {}) {
  const elements = new Map(), listeners = [], commands=[];let activated,stateRequests=0,resolveState;
  const get = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', value: '', disabled: false, hidden: false,
      dataset: {}, handlers: {}, attrs: {}, style: { setProperty() {} }, addEventListener(name, fn) { this.handlers[name] = fn; },
      setAttribute(name, value) { this.attrs[name] = value; }, getAttribute(name) { return this.attrs[name]; }, focus() {},
      querySelector() { return get('switchState'); }, contains() { return false; } });
    return elements.get(id);
  };
  get('connectionInfo').textContent = '侧栏 v1.5.0 · 正在连接后台…';
  const chrome = {
    runtime: { onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: async message => {
      commands.push(message);
      if (message.type === 'HT_HEALTH') {
        if (options.offline) throw new Error('no receiver');
        return { ok: true, version: options.version || '1.5.0', debuggerAvailable: options.debuggerAvailable !== false };
      }
      if (message.type === 'HT_STATE') {
        if(options.delayedState && ++stateRequests>1)return new Promise(resolve=>{resolveState=resolve});
        return { ok: true, tabId: 7, target: { tabId: 7, kind: 'dom', label: '文本框' } };
      }
      if (message.type === 'HT_START') {
        listeners.forEach(fn => fn({ type: 'HT_PROGRESS', tabId: 7, runId: 'short', sequence:1, running: options.live === true, completed: options.live ? 0 : 2, total: 2 }));
        return { ok: true, runId: 'short' };
      }
      if(message.type==='HT_PAUSE')return{ok:true,paused:message.paused,runId:message.runId};
      return { ok: true };
    } },
    storage: { local: { get: async () => ({ draft: '中文', speed: 100, humanMode: false }), set: async () => {} } },
    tabs: { onActivated: { addListener(fn) {activated=fn} } }
  };
  vm.runInNewContext(source, { chrome, document: { getElementById: get, body: { dataset: {} }, addEventListener() {} }, window: { addEventListener() {} },
    navigator: {}, setTimeout, clearTimeout, console });
  await new Promise(resolve => setTimeout(resolve, 5));
  return { get, commands, emit:message=>listeners.forEach(fn=>fn(message)),activate:()=>activated(),resolveState:state=>resolveState(state) };
}
(async () => {
  const online = await fixture();
  assert.match(online.get('connectionInfo').textContent, /后台 v1\.5\.0 已连接.*Google 输入可用/);
  await online.get('startButton').handlers.click();
  assert.equal(online.get('startButton').disabled, false);
  assert.equal(online.get('status').textContent, '输入完成，共 2 字。');
  console.log('PASS actual backend version is visible and short completion stays complete');
  const missing = await fixture({ debuggerAvailable: false });
  assert.match(missing.get('connectionInfo').textContent, /Google 调试接口不可用/);
  assert.equal(missing.get('startButton').disabled, false);
  console.log('PASS unavailable Docs interface is visible while ordinary input remains available');
  const stale = await fixture({ version: '1.1.1' });
  assert.match(stale.get('status').textContent, /版本不一致/);
  assert.equal(stale.get('startButton').disabled, true);
  console.log('PASS stale background version is reported');
  const offline = await fixture({ offline: true });
  assert.match(offline.get('connectionInfo').textContent, /后台未连接/);
  assert.equal(offline.get('startButton').disabled, true);
  console.log('PASS disconnected background is reported');
  const live=await fixture({live:true});await live.get('startButton').handlers.click();
  assert.equal(live.get('startButton').disabled,false);assert.equal(live.get('startLabel').textContent,'暂停');
  live.emit({type:'HT_PROGRESS',tabId:7,runId:'short',sequence:2,running:true,paused:false,completed:1,total:2});
  assert.equal(live.get('typingProgress').value,1);assert.match(live.get('progressLabel').textContent,/50%/);
  await live.get('startButton').handlers.click();assert.equal(live.get('startLabel').textContent,'继续输入');assert.equal(live.get('stopButton').disabled,false);
  await live.get('startButton').handlers.click();assert.equal(live.get('startLabel').textContent,'暂停');
  assert.equal(live.commands.filter(c=>c.type==='HT_START').length,1);assert.deepEqual(live.commands.filter(c=>c.type==='HT_PAUSE').map(c=>c.paused),[true,false]);
  console.log('PASS live progress and Pause / Resume reuse the current run');
  live.emit({type:'HT_PROGRESS',tabId:7,runId:'short',sequence:1,running:true,paused:true,completed:0,total:2});
  assert.equal(live.get('typingProgress').value,1);
  live.emit({type:'HT_PROGRESS',tabId:7,runId:'short',sequence:3,running:false,paused:false,completed:2,total:2});
  live.emit({type:'HT_PROGRESS',tabId:7,runId:'short',sequence:4,running:true,paused:true,completed:1,total:2});
  assert.equal(live.get('startLabel').textContent,'开始输入');assert.equal(live.get('typingProgress').value,2);
  console.log('PASS stale and late progress never revive a finished run');
  const race=await fixture({live:true,delayedState:true});await race.get('startButton').handlers.click();race.activate();
  race.emit({type:'HT_PROGRESS',tabId:7,runId:'short',sequence:3,running:true,paused:true,completed:1,total:2});
  race.resolveState({ok:true,tabId:7,target:{tabId:7,kind:'dom',label:'文本框'},run:{runId:'short',sequence:1,running:true,paused:false,completed:0,total:2}});
  await new Promise(r=>setTimeout(r,5));assert.equal(race.get('typingProgress').value,1);assert.equal(race.get('startLabel').textContent,'继续输入');
  console.log('PASS delayed tab state cannot rewind newer progress or pause state');
  console.log('7 / 7 passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
