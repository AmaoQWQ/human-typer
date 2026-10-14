const PANEL_VERSION = "1.5.0";
const els = Object.fromEntries([
  "aboutButton", "aboutPopover", "pasteButton", "clearButton", "draft", "charCount",
  "startButton", "stopButton", "speed", "humanToggle", "status", "targetButton", "targetStatus", "docsPermissionHint", "connectionInfo",
  "targetTitle", "targetSubtitle", "targetBadge", "startLabel", "startIconPath", "speedValue", "sessionLabel", "progressLabel", "typingProgress", "draftSaveStatus"
].map((id) => [id, document.getElementById(id)]));
let running = false;
let paused = false;
let controlBusy = false;
let busy = false;
let cancelStart = false;
let currentTabId = null;
let runTabId = null;
let currentRunId = null;
const progressSequences = new Map();
let selectedTarget = null;
let activeService = null;
let lastProgress = { completed: 0, total: 0 };
const finishedRuns = new Set();
let saveTimer;
const characterCount = (text) => Array.from(text).length;
function status(message, kind = "") {
  els.status.textContent = message;
  els.status.dataset.kind = kind;
}
function render() {
  els.startButton.disabled = busy || controlBusy || (!running && !selectedTarget);
  els.stopButton.disabled = !running && !busy;
  els.targetButton.disabled = running || busy;
  els.docsPermissionHint.hidden = !selectedTarget?.kind?.startsWith("google-");
  document.body.dataset.running = String(running);
  document.body.dataset.paused = String(paused);
  document.body.dataset.targetReady = String(Boolean(selectedTarget));
  els.targetTitle.textContent = selectedTarget?.label || "选择网页输入位置";
  els.targetButton.setAttribute("aria-label", selectedTarget ? "重新选择网页输入位置，当前：" + selectedTarget.label : "选择网页输入位置");
  els.targetSubtitle.textContent = selectedTarget ? "点击可重新选择" : "然后点击网页中的输入位置";
  els.targetBadge.textContent = selectedTarget ? "已选择" : "待选择";
  els.startLabel.textContent = busy ? "正在连接…" : controlBusy ? "正在切换…" : running ? paused ? "继续输入" : "暂停" : "开始输入";
  els.startButton.setAttribute("aria-label", els.startLabel.textContent);
  els.startIconPath.setAttribute("d", running ? paused ? "M8 5l10 7-10 7V5Z" : "M9 6v12m6-12v12" : "M4 12h15m-6-6 6 6-6 6");
  els.sessionLabel.textContent = busy ? "正在连接" : running ? paused ? "已暂停" : "输入进行中" :
    lastProgress.total && lastProgress.completed >= lastProgress.total ? "输入完成" : !selectedTarget ? "未选择输入位置" : "准备就绪";
  els.typingProgress.max = Math.max(1, lastProgress.total);
  els.typingProgress.value = lastProgress.completed;
  els.progressLabel.textContent = lastProgress.total
    ? Math.floor(lastProgress.completed / lastProgress.total * 100) + "% · " + lastProgress.completed.toLocaleString("zh-CN") + " / " + lastProgress.total.toLocaleString("zh-CN") + " 字" : "等待开始";
  els.typingProgress.setAttribute("aria-valuetext", lastProgress.total
    ? "已输入 " + lastProgress.completed + " 字，共 " + lastProgress.total + " 字" : "输入尚未开始");
  const switchState = els.humanToggle.querySelector(".switch-state");
  switchState.textContent = els.humanToggle.getAttribute("aria-checked") === "true" ? "开" : "关";
  els.targetStatus.textContent = selectedTarget
    ? selectedTarget.kind === "google-sheets" ? "在 " + selectedTarget.cell + " 内输入，换行不会切换单元格。" : "位置已保存。点击侧栏不会取消选择。"
    : activeService?.hint || "点击上方按钮，再点网页中的输入位置。";
}
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "无法连接扩展，请在扩展管理页重新加载。");
  return result;
}
async function refresh() {
  const state = await request({ type: "HT_STATE" });
  const previousTabId = currentTabId;
  currentTabId = state.tabId;
  activeService = state.service || null;
  selectedTarget = state.target;
  if (previousTabId === state.tabId && state.run?.runId &&
    (finishedRuns.has(state.run.runId) || state.run.sequence < (progressSequences.get(state.run.runId) ?? -1))) {
    render(); return;
  }
  if (state.run?.runId && Number.isFinite(state.run.sequence)) {
    progressSequences.set(state.run.runId, Math.max(progressSequences.get(state.run.runId) ?? -1, state.run.sequence));
  }
  running = state.run?.running === true;
  paused = running && state.run?.paused === true;
  currentRunId = running ? state.run.runId : null;
  if (state.run?.runId && !running) finishedRuns.add(state.run.runId);
  runTabId = running ? state.tabId : null;
  lastProgress = { completed: state.run?.completed || 0, total: state.run?.total || 0 };
  render();
  if (running) status(paused ? "已暂停，点击继续输入。" : "正在输入…");
  if (!running && selectedTarget && !lastProgress.total) status("输入位置已选择。");
}
function updateCount() { els.charCount.textContent = characterCount(els.draft.value).toLocaleString("en-US"); }
function saveDraft() {
  clearTimeout(saveTimer);
  const savedText = els.draft.value;
  chrome.storage.local.set({ draft: savedText }).then(() => {
    if (els.draft.value === savedText) els.draftSaveStatus.textContent = "已保存到本机";
  }).catch(() => { els.draftSaveStatus.textContent = "草稿保存失败"; });
}
els.draft.addEventListener("input", () => {
  updateCount(); clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 180);
  els.draftSaveStatus.textContent = "正在保存…";
});
els.draft.addEventListener("blur", saveDraft);
window.addEventListener("pagehide", saveDraft);
els.pasteButton.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return status("剪贴板里没有文本。");
    els.draft.setRangeText(text, els.draft.selectionStart, els.draft.selectionEnd, "end");
    updateCount(); saveDraft();
    status("已粘贴。", "success");
  } catch { status("无法读取剪贴板，请直接在草稿框中粘贴。", "error"); }
});
els.clearButton.addEventListener("click", () => {
  els.draft.value = ""; updateCount(); saveDraft(); status("草稿已清空。");
});
function updateSpeed() {
  els.speed.style.setProperty("--speed-fill", els.speed.value + "%");
  const perMinute = Math.round(60000 / (650 - Number(els.speed.value) * 5.7));
  els.speedValue.textContent = "约 " + perMinute + " 字 / 分钟";
}
els.speed.addEventListener("input", () => {
  updateSpeed();
  chrome.storage.local.set({ speed: Number(els.speed.value) });
});
els.humanToggle.addEventListener("click", () => {
  const enabled = els.humanToggle.getAttribute("aria-checked") !== "true";
  els.humanToggle.setAttribute("aria-checked", String(enabled));
  chrome.storage.local.set({ humanMode: enabled });
  render();
});
els.aboutButton.addEventListener("click", () => {
  const expanded = els.aboutButton.getAttribute("aria-expanded") === "true";
  els.aboutButton.setAttribute("aria-expanded", String(!expanded));
  els.aboutPopover.hidden = expanded;
});
function closeHelp(returnFocus = false) {
  els.aboutButton.setAttribute("aria-expanded", "false");
  els.aboutPopover.hidden = true;
  if (returnFocus) els.aboutButton.focus();
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.aboutPopover.hidden) closeHelp(true);
});
document.addEventListener("pointerdown", (event) => {
  if (!els.aboutPopover.hidden && !els.aboutPopover.contains(event.target) && !els.aboutButton.contains(event.target)) closeHelp();
});
els.targetButton.addEventListener("click", async () => {
  busy = true; render();
  try {
    const result = await request({ type: "HT_PREPARE" });
    currentTabId = result.tabId;
    activeService = result.service || null;
    selectedTarget = null;
    lastProgress = { completed: 0, total: 0 };
    status(activeService?.hint || "请点击网页中的输入位置。");
  } catch (error) { status(error.message, "error"); }
  finally { busy = false; render(); }
});
els.startButton.addEventListener("click", async () => {
  if (running) {
    if (controlBusy) return;
    const id = currentRunId, tabId = runTabId;
    controlBusy = true; render();
    try {
      const result = await request({ type: "HT_PAUSE", tabId, runId: id, paused: !paused });
      if (running && currentRunId === id) {
        paused = result.paused === true;
        status(paused ? "已暂停，点击继续输入。" : "正在输入…");
      }
    } catch (error) { if (running && currentRunId === id) status(error.message, "error"); }
    finally { controlBusy = false; render(); }
    return;
  }
  const text = els.draft.value;
  if (!text.trim()) { status("先输入或粘贴草稿。", "error"); els.draft.focus(); return; }
  if (!selectedTarget) return status("请先选择网页输入位置。", "error");
  busy = true; cancelStart = false; runTabId = selectedTarget.tabId;
  lastProgress = { completed: 0, total: characterCount(text.replace(/\r\n?/g, "\n")) };
  render();
  try {
    if (cancelStart) throw new Error("已取消，输入尚未开始。");
    status("正在恢复网页输入位置…");
    const result = await request({ type: "HT_START", tabId: selectedTarget.tabId, text,
      speed: Number(els.speed.value), humanMode: els.humanToggle.getAttribute("aria-checked") === "true" });
    if (cancelStart) {
      await request({ type: "HT_STOP", tabId: runTabId || currentTabId });
      return;
    }
    if (!finishedRuns.has(result.runId)) {
      running = true;
      paused = false;
      currentRunId = result.runId;
      status("正在输入…");
    }
  } catch (error) { running = false; paused = false; currentRunId = null; runTabId = null; status(error.message, "error"); }
  finally { busy = false; render(); }
});
els.stopButton.addEventListener("click", async () => {
  if (!runTabId) return;
  try {
    if (busy) cancelStart = true;
    status("正在停止输入…");
    await request({ type: "HT_STOP", tabId: runTabId });
  } catch (error) { status(error.message, "error"); running = false; paused = false; currentRunId = null; render(); }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "HT_TARGET_CLEARED" && message.tabId === currentTabId) {
    selectedTarget = null; render();
    if (!running && !busy) status(activeService?.hint || "请重新选择输入位置。");
  }
  if (message?.type === "HT_TARGET_UPDATE" && message.target.tabId === currentTabId) {
    selectedTarget = message.target;
    render();
    if (!running && !busy) status("输入位置已选择。", "success");
  }
  if (message?.type === "HT_INVALIDATED" && message.tabId === currentTabId) {
    selectedTarget = null; running = false; paused = false; currentRunId = null; lastProgress = { completed: 0, total: 0 }; render();
    status("网页已刷新或跳转，请重新选择输入位置。");
  }
  if (message?.type === "HT_NOTICE" && message.tabId === currentTabId) status(message.error, "error");
  if (message?.type === "HT_PROGRESS" && (message.tabId === currentTabId || message.tabId === runTabId)) {
    if (finishedRuns.has(message.runId)) return;
    if (Number.isFinite(message.sequence)) {
      if (message.sequence <= (progressSequences.get(message.runId) ?? -1)) return;
      progressSequences.set(message.runId, message.sequence);
      if (progressSequences.size > 100) progressSequences.delete(progressSequences.keys().next().value);
    }
    running = message.running;
    paused = running && message.paused === true;
    currentRunId = running ? message.runId : null;
    lastProgress = { completed: message.completed || 0, total: message.total || 0 };
    if (running) {
      runTabId = message.tabId;
      status(paused ? "已暂停，点击继续输入。" : "正在输入…");
    } else {
      finishedRuns.add(message.runId);
      if (finishedRuns.size > 100) finishedRuns.delete(finishedRuns.values().next().value);
      runTabId = null;
      status(message.error || (message.stopped ? "已停止，已输入 " + message.completed + " 字。" : "输入完成，共 " + message.completed + " 字。"),
        message.error ? "error" : "success");
    }
    render();
  }
});
chrome.tabs.onActivated.addListener(() => { refresh().catch((error) => status(error.message, "error")); });
async function init() {
  try {
    const health = await request({ type: "HT_HEALTH" });
    els.connectionInfo.textContent = "侧栏 v" + PANEL_VERSION + " · 后台 v" + (health.version || "未知") + " 已连接" +
      (health.debuggerAvailable ? " · Google 输入可用" : " · Google 调试接口不可用");
    if (health.version !== PANEL_VERSION) {
      throw new Error("侧栏与后台版本不一致，请重新加载扩展，并关闭再打开侧栏。");
    }
  } catch (error) {
    if (!els.connectionInfo.textContent.includes("已连接")) {
      els.connectionInfo.textContent = "侧栏 v" + PANEL_VERSION + " · 后台未连接，请重新加载扩展";
    }
    throw error;
  }
  const prefs = await chrome.storage.local.get(["draft", "speed", "humanMode"]);
  els.draft.value = typeof prefs.draft === "string" ? prefs.draft : "";
  els.speed.value = String(Number.isFinite(prefs.speed) ? prefs.speed : 25);
  els.humanToggle.setAttribute("aria-checked", String(prefs.humanMode !== false));
  updateCount();
  await refresh();
  updateSpeed();
}
render();
init().catch((error) => status(error.message, "error"));
