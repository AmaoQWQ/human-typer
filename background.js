importScripts("google-apps.js", "typing-behavior.js");
const BACKGROUND_VERSION = "1.5.0";
const nativeRuns = new Map();
const targetWrites = new Map();
const runWrites = new Map();
const startingTabs = new Set();
const targetKey = id => "ht.target." + id;
const runKey = id => "ht.run." + id;
const broadcast = message => chrome.runtime.sendMessage(message).catch(() => {});
const routeOptions = route => route.documentId ? { documentId: route.documentId } : { frameId: route.frameId || 0 };
function debuggerAvailable() {
  const api = chrome.debugger;
  return Boolean(api && typeof api.attach === "function" && typeof api.detach === "function" &&
    typeof api.sendCommand === "function" && api.onDetach && typeof api.onDetach.addListener === "function");
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("没有找到当前网页。");
  return tab;
}
async function installTracker(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const files = ["google-apps.js", "typing-behavior.js", "content.js"];
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: !HTGoogleApps.match(tab.url) }, files }); }
  catch {
    try { await chrome.scripting.executeScript({ target: { tabId }, files }); }
    catch { throw new Error("当前网页没有输入权限。请在网页上点击扩展图标后再选择；浏览器内部页面不支持输入。"); }
  }
}
if (chrome.sidePanel?.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.action.onClicked.addListener(tab => {
  if (!tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  installTracker(tab.id).catch(error => broadcast({ type: "HT_NOTICE", tabId: tab.id, error: error.message }));
});
async function publish(run, running) {
  await writeRun(run.tabId, async () => {
    const message = { type: "HT_PROGRESS", tabId: run.tabId, runId: run.id, native: true, protocol: 5,
      running, paused: running && run.paused, sequence: ++run.sequence,
      completed: run.completed, total: run.total, stopped: run.stopped, error: run.error || "", route: run.route };
    await chrome.storage.session.set({ [runKey(run.tabId)]: message });
    await broadcast(message);
  });
}
async function sendToTarget(route, message) {
  try { return await chrome.tabs.sendMessage(route.tabId, message, routeOptions(route)); }
  catch { throw new Error("目标网页已刷新、跳转或关闭，请重新选择输入位置。"); }
}
async function checkedMessage(run, type, details = {}) {
  const result = await sendToTarget(run.route, { ...details, type, runId: run.id, targetId: run.route.targetId });
  if (!result?.ok) throw new Error(result?.error || "输入目标已失效，请重新选择。");
  if (type === "HT_FOCUS" && result.kind !== run.route.kind) throw new Error("输入区域类型已改变，请重新选择。");
  return result;
}
async function focusDocs(run) { return checkedMessage(run, "HT_FOCUS"); }
async function focusWhenReady(run) {
  while (!run.stopped) {
    if (!await HTTyping.ready(run)) return false;
    await focusDocs(run);
    if (!run.paused && !run.stopped) return true;
  }
  return false;
}
async function nativeKey(run, key, code, virtualKey, modifiers = 0, onKeyDown = () => {}) {
  const target = { tabId: run.tabId }, params = { key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers };
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
  onKeyDown();
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
}
async function nativeText(run, character, onInserted = () => {}) {
  if (run.route.kind === "google-field") await checkedMessage(run, "HT_NATIVE_BEFORE", { text: character === "\t" ? "    " : character });
  if (character === "\n") {
    await nativeKey(run, "Enter", "Enter", 13, run.route.kind === "google-sheets" ? run.cellBreakModifier : 0);
  } else {
    const text = character === "\t" ? "    " : character;
    if (["google-slides", "google-sheets"].includes(run.route.kind)) {
      // These canvas editors handle trusted keypress events, not bridge-only DOM changes.
      for (const part of Array.from(text)) {
        await chrome.debugger.sendCommand({ tabId: run.tabId }, "Input.dispatchKeyEvent", { type: "char", text: part, unmodifiedText: part });
      }
    } else await chrome.debugger.sendCommand({ tabId: run.tabId }, "Input.insertText", { text });
  }
  onInserted();
  await checkedMessage(run, "HT_NATIVE_AFTER");
}
async function detach(run) {
  if (!run.attached) return;
  run.attached = false;
  await chrome.debugger.detach({ tabId: run.tabId }).catch(() => {});
}
async function release(run) {
  if (run.locked) {
    await sendToTarget(run.route, { type: "HT_NATIVE_END", runId: run.id, targetId: run.route.targetId }).catch(() => {});
    run.locked = false;
  }
  await detach(run);
}
async function typeDocs(run) {
  let pendingTypo = false;
  try {
    for (const character of run.chars) {
      if (!await HTTyping.ready(run)) break;
      const wrongLetter = HTTyping.typo(run, character);
      if (wrongLetter) {
        if (!await focusWhenReady(run)) break;
        await nativeText(run, wrongLetter, () => { pendingTypo = true; run.pendingTypo = true; });
        await HTTyping.sleep(run, HTTyping.correctionDelay());
        if (!await focusWhenReady(run)) break;
        await nativeKey(run, "Backspace", "Backspace", 8, 0, () => { pendingTypo = false; run.pendingTypo = false; });
        await checkedMessage(run, "HT_NATIVE_AFTER");
        if (run.stopped) break;
        await HTTyping.sleep(run, HTTyping.afterCorrection());
      }
      if (!await focusWhenReady(run)) break;
      await nativeText(run, character);
      run.completed++;
      await publish(run, true);
      if (run.completed < run.total) {
        await HTTyping.sleep(run, HTTyping.delay(run, character));
      }
    }
  } catch (error) { run.error = error.message; run.stopped = true; }
  finally {
    if (pendingTypo && run.attached && !run.targetChanged) {
      try { await focusDocs(run); await nativeKey(run, "Backspace", "Backspace", 8); await checkedMessage(run, "HT_NATIVE_AFTER"); }
      catch (error) { run.error ||= "临时错字未能删除：" + error.message; run.stopped = true; }
    }
    await release(run); nativeRuns.delete(run.tabId); await publish(run, false);
  }
}
async function start(message) {
  const tab = await activeTab();
  if (tab.id !== message.tabId) throw new Error("当前网页已切换，请重新选择输入位置。");
  if (startingTabs.has(tab.id)) throw new Error("此网页正在开始输入，请稍候。");
  startingTabs.add(tab.id);
  try { return await startOnTab(message, tab); }
  finally { startingTabs.delete(tab.id); }
}
async function startOnTab(message, tab) {
  const stored = await chrome.storage.session.get([targetKey(tab.id), runKey(tab.id)]), route = stored[targetKey(tab.id)];
  if (!route?.targetId) throw new Error("请先点击目标选择按钮，再点网页中的输入位置。");
  if (stored[runKey(tab.id)]?.running || nativeRuns.has(tab.id)) throw new Error("此网页仍在输入，请先点击停止。");
  const text = String(message.text || "").replace(/\r\n?/g, "\n");
  if (!text) throw new Error("没有可输入的文字。");
  if (route.multiline === false && text.includes("\n")) throw new Error("此输入框只支持单行文字，请移除草稿中的换行。");
  const id = crypto.randomUUID();
  if (!HTGoogleApps.nativeKind(route.kind)) {
    await chrome.storage.session.set({ [runKey(tab.id)]: { tabId: tab.id, runId: id, protocol: 5, native: false,
      running: true, paused: false, sequence: 0, completed: 0, total: Array.from(text).length, route } });
    try {
      const result = await sendToTarget(route, { ...message, type: "HT_DOM_START", runId: id, targetId: route.targetId, text });
      if (!result?.ok) throw new Error(result?.error || "网页没有接受输入。");
    } catch (error) { await chrome.storage.session.remove(runKey(tab.id)); throw error; }
    return { ok: true, runId: id };
  }
  if (!HTGoogleApps.routeMatches(route, tab.url)) throw new Error("Google 应用或文档已切换，请重新选择输入位置。");
  if (!debuggerAvailable() || !await chrome.permissions.contains({ permissions: ["debugger"] })) {
    throw new Error("Google 输入连接权限不可用。请重新加载 1.5.0 或更新版本，并确认扩展已启用且获得调试权限。");
  }
  const platform = chrome.runtime.getPlatformInfo ? await chrome.runtime.getPlatformInfo() : { os: "win" };
  const run = { id, tabId: tab.id, route, chars: Array.from(text), total: Array.from(text).length, completed: 0,
    cellBreakModifier: platform.os === "mac" ? 4 : 2, speed: Math.max(0, Math.min(100, Number(message.speed) || 0)),
    human: message.humanMode === true, paused: false, sequence: 0, stopped: false, attached: false, locked: false, wake: null };
  nativeRuns.set(tab.id, run);
  try {
    try { await chrome.debugger.attach({ tabId: tab.id }, "1.3"); }
    catch { throw new Error("无法建立 Google 输入连接。请关闭此标签页的开发者工具或其他调试连接，再点击开始输入。"); }
    run.attached = true;
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.bringToFront");
    run.locked = true;
    const prepared = await checkedMessage(run, "HT_NATIVE_BEGIN");
    if (run.stopped) throw new Error("输入已取消。");
    if (prepared.enterEdit) await nativeKey(run, "Enter", "Enter", 13);
    await checkedMessage(run, "HT_NATIVE_READY");
    if (run.stopped) throw new Error("输入已取消。");
    await publish(run, true); void typeDocs(run);
    return { ok: true, runId: id };
  } catch (error) { await release(run); nativeRuns.delete(tab.id); throw error; }
}
async function stop(tabId) {
  const run = nativeRuns.get(tabId);
  if (run) { run.stopped = true; run.wake?.(); return { ok: true }; }
  const stored = await chrome.storage.session.get([targetKey(tabId), runKey(tabId)]), state = stored[runKey(tabId)];
  const route = state?.route || stored[targetKey(tabId)];
  if (state?.native && state.running) {
    if (route) await sendToTarget(route, { type: "HT_NATIVE_END", runId: state.runId, targetId: route.targetId }).catch(() => {});
    const ended = { ...state, running: false, paused: false, stopped: true, error: "输入连接已结束，请重新选择输入位置。" };
    await chrome.storage.session.set({ [runKey(tabId)]: ended }); await broadcast(ended);
  } else if (route) await sendToTarget(route, { type: "HT_DOM_STOP" });
  return { ok: true };
}
async function setPaused(message) {
  const run = nativeRuns.get(message.tabId);
  if (run && !run.stopped && (!message.runId || message.runId === run.id)) {
    run.paused = message.paused === true;
    run.wake?.();
    await publish(run, true);
    return { ok: true, paused: run.paused, runId: run.id };
  }
  const stored = await chrome.storage.session.get(runKey(message.tabId)), state = stored[runKey(message.tabId)];
  if (!state?.running || state.native || (message.runId && message.runId !== state.runId)) throw new Error("输入任务已结束。");
  return sendToTarget(state.route, { type: "HT_DOM_PAUSE", runId: state.runId, paused: message.paused === true });
}
async function writeRun(tabId, work) {
  const next = (runWrites.get(tabId) || Promise.resolve()).catch(() => {}).then(work);
  runWrites.set(tabId, next);
  try { return await next; } finally { if (runWrites.get(tabId) === next) runWrites.delete(tabId); }
}
async function writeTarget(tabId, work) {
  const next = (targetWrites.get(tabId) || Promise.resolve()).catch(() => {}).then(work);
  targetWrites.set(tabId, next);
  try { return await next; } finally { if (targetWrites.get(tabId) === next) targetWrites.delete(tabId); }
}
async function handle(message, sender) {
  if (message.type === "HT_TARGET" && sender.tab) {
    if (!message.targetId || !["dom", "google-field", "google-docs", "google-sheets", "google-slides"].includes(message.kind)) return { ok: false };
    const route = { protocol: 5, targetId: message.targetId, tabId: sender.tab.id, frameId: sender.frameId || 0, documentId: sender.documentId,
      kind: message.kind, native: HTGoogleApps.nativeKind(message.kind), app: message.app || null,
      multiline: message.multiline !== false, cell: message.cell || "", surface: message.surface || "", label: message.label };
    if (route.native && !HTGoogleApps.routeMatches(route, sender.tab.url || (await chrome.tabs.get(route.tabId)).url)) return { ok: false };
    return writeTarget(route.tabId, async () => {
      await chrome.storage.session.set({ [targetKey(route.tabId)]: route });
      await broadcast({ type: "HT_TARGET_UPDATE", target: route }); return { ok: true };
    });
  }
  if (message.type === "HT_CLEAR_TARGET" && sender.tab) {
    return writeTarget(sender.tab.id, async () => {
      await chrome.storage.session.remove(targetKey(sender.tab.id));
      await broadcast({ type: "HT_TARGET_CLEARED", tabId: sender.tab.id }); return { ok: true };
    });
  }
  if (message.type === "HT_NATIVE_CANCEL" && sender.tab) {
    const run = nativeRuns.get(sender.tab.id);
    if (run?.id === message.runId) {
      run.stopped = true; run.targetChanged = true;
      run.error = "网页输入位置被改变，输入已停止。" + (run.pendingTypo ? "原位置可能保留了一个尚未修正的错字。" : "");
      run.wake?.();
    }
    return { ok: true };
  }
  if (message.type === "HT_NOTICE" && sender.tab) {
    await broadcast({ type: "HT_NOTICE", tabId: sender.tab.id, error: message.error }); return { ok: true };
  }
  if (message.type === "HT_DOM_PROGRESS" && sender.tab) {
    return writeRun(sender.tab.id, async () => {
      const key = runKey(sender.tab.id), stored = await chrome.storage.session.get(key);
      if (stored[key]?.runId !== message.runId || (Number.isFinite(message.sequence) && message.sequence <= stored[key].sequence)) return { ok: true };
      const state = { ...stored[key], ...message, type: "HT_PROGRESS", tabId: sender.tab.id };
      await chrome.storage.session.set({ [key]: state }); await broadcast(state); return { ok: true };
    });
  }
  if (sender.tab || sender.id !== chrome.runtime.id) return { ok: false };
  if (message.type === "HT_HEALTH") return { ok: true, version: BACKGROUND_VERSION, debuggerAvailable: debuggerAvailable(), googleApps: HTGoogleApps.apps.map(app => app.id) };
  if (message.type === "HT_STATE") {
    const tab = await activeTab(), stored = await chrome.storage.session.get([targetKey(tab.id), runKey(tab.id)]);
    const target = stored[targetKey(tab.id)], run = stored[runKey(tab.id)];
    if (run?.running && run.native && !nativeRuns.has(tab.id)) await stop(tab.id);
    const current = run?.running && run.native && !nativeRuns.has(tab.id) ? (await chrome.storage.session.get(runKey(tab.id)))[runKey(tab.id)] : run;
    return { ok: true, tabId: tab.id, service: HTGoogleApps.match(tab.url), target: target?.targetId ? target : null, run: current?.protocol === 5 ? current : null };
  }
  if (message.type === "HT_PREPARE") {
    const tab = await activeTab(), state = await chrome.storage.session.get(runKey(tab.id));
    if (state[runKey(tab.id)]?.running) throw new Error("请先停止输入，再重新选择。");
    await installTracker(tab.id); await chrome.tabs.sendMessage(tab.id, { type: "HT_ARM" });
    await writeTarget(tab.id, () => chrome.storage.session.remove(targetKey(tab.id)));
    return { ok: true, tabId: tab.id, service: HTGoogleApps.match(tab.url) };
  }
  if (message.type === "HT_START") return start(message);
  if (message.type === "HT_PAUSE") return setPaused(message);
  if (message.type === "HT_STOP") return stop(message.tabId);
  return { ok: false };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message?.type?.startsWith("HT_")) return false;
  handle(message, sender).then(reply, error => reply({ ok: false, error: error.message })); return true;
});
const detachAPI = chrome.debugger;
if (detachAPI && detachAPI.onDetach && typeof detachAPI.onDetach.addListener === "function") {
  detachAPI.onDetach.addListener((source, reason) => {
    const run = nativeRuns.get(source.tabId);
    if (run?.attached) { run.attached = false; run.stopped = true; run.error = "浏览器输入连接已断开：" + reason; run.wake?.(); }
  });
}
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "loading") return;
  const run = nativeRuns.get(tabId);
  if (run) { run.stopped = true; run.error = "页面已刷新或跳转，输入停止。"; run.wake?.(); }
  chrome.storage.session.remove([targetKey(tabId), runKey(tabId)]).catch(() => {}); broadcast({ type: "HT_INVALIDATED", tabId });
});
chrome.tabs.onRemoved.addListener(tabId => {
  const run = nativeRuns.get(tabId); if (run) { run.stopped = true; run.wake?.(); }
  chrome.storage.session.remove([targetKey(tabId), runKey(tabId)]).catch(() => {});
});
