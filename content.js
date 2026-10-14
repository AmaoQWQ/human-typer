(() => {
  const VERSION = 5;
  if (globalThis.__humanTyper?.version === VERSION) return;
  globalThis.__humanTyper?.dispose();
  const events = new AbortController();
  const app = globalThis.HTGoogleApps?.match(location.href) || null;
  let target = null;
  let restoring = false;
  let session = null;
  let nativeLock = null;
  let captureEpoch = 0;
  const notify = (message) => {
    try { chrome.runtime.sendMessage(message).catch(() => {}); } catch {}
  };
  const textControl = el => el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && ["text", "search", "url", "tel"].includes(el.type));
  const usable = el => el?.isConnected && !el.disabled && !el.readOnly &&
    el.getAttribute("aria-disabled") !== "true" && el.getAttribute("aria-readonly") !== "true";
  function editorFor(node) {
    if (textControl(node)) return node;
    const el = node instanceof Element ? node : node?.parentElement;
    const editable = el?.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]');
    return editable?.isContentEditable ? editable : null;
  }
  function bridgeInput() {
    try {
      const frame = document.querySelector(".docs-texteventtarget-iframe");
      const doc = frame?.contentDocument;
      if (doc && !watchedFrames.has(doc)) {
        watchedFrames.add(doc);
        doc.addEventListener("keydown", cancelNavigation, { capture: true, signal: events.signal });
      }
      return frame?.contentDocument?.querySelector('[contenteditable="true"]') || null;
    } catch { return null; }
  }
  const watchedFrames = new WeakSet();
  function cancelNavigation(event) {
    if (nativeLock && event.isTrusted && /^(Arrow|Page|Home$|End$|Escape$|Tab$)/.test(event.key)) {
      notify({ type: "HT_NATIVE_CANCEL", runId: nativeLock.runId });
    }
  }
  function cellReference() { return document.querySelector("#t-name-box")?.value?.trim() || ""; }
  function cellEditing(editor) {
    const rect = editor?.getBoundingClientRect();
    return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
      editor.getAttribute("aria-label") === cellReference());
  }
  function scopeKey() {
    const url = new URL(location.href);
    if (app?.id === "sheets") return url.pathname + "|" + (url.searchParams.get("gid") || /gid=(\d+)/.exec(url.hash)?.[1] || "0");
    if (app?.id === "slides") return url.pathname + "|" + (url.searchParams.get("slide") || url.hash.replace(/^#slide=/, ""));
    if (app?.id === "docs") return url.pathname + "|" + (url.searchParams.get("tab") || "");
    return url.pathname;
  }
  function snapshot(record) {
    if (restoring || !record || !usable(record.editor)) return;
    // Canvas editors keep their caret in their own model, independently of the bridge DOM.
    if (["google-docs", "google-slides", "google-sheets"].includes(record.kind)) return;
    if (textControl(record.editor)) {
      record.start = record.editor.selectionStart;
      record.end = record.editor.selectionEnd;
      record.direction = record.editor.selectionDirection;
    } else {
      const selection = record.editor.ownerDocument.getSelection();
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        if (record.editor.contains(range.startContainer) && record.editor.contains(range.endContainer)) record.range = range.cloneRange();
      }
    }
  }
  function fieldMultiline(editor) {
    if (editor instanceof HTMLTextAreaElement) return true;
    if (editor instanceof HTMLInputElement) return false;
    if (editor.getAttribute("aria-multiline") === "false") return false;
    if (app?.id === "keep" && (editor.getAttribute("role") === "textbox" ||
      /title|标题/i.test(editor.getAttribute("aria-label") || editor.getAttribute("data-placeholder") || ""))) return false;
    return true;
  }
  function fieldName(editor) {
    const ids = editor.getAttribute("aria-labelledby")?.trim().split(/\s+/) || [];
    const named = ids.map(id => editor.ownerDocument.getElementById(id)?.textContent?.trim() || "").filter(Boolean).join(" ");
    if (editor.getAttribute("aria-label") || named) return editor.getAttribute("aria-label") || named;
    if (app?.id === "keep") return editor.getAttribute("role") === "combobox" ? "记事" : "标题";
    return editor.getAttribute("placeholder") || editor.getAttribute("data-placeholder") || "输入框";
  }
  function remember(editor, kind = app ? "google-field" : "dom", options = {}) {
    if (session || nativeLock || restoring) return;
    if (!editor && !["google-docs", "google-slides"].includes(kind)) return;
    const cell = kind === "google-sheets" ? cellReference() : "";
    if (kind === "google-sheets" && !/^[A-Z]+\d+$/i.test(cell)) {
      clearTarget(); notify({ type: "HT_NOTICE", error: "请选择一个单元格，暂不支持一次选择多个单元格。" }); return;
    }
    const scope = scopeKey();
    if (target?.editor !== editor || target?.kind !== kind || target?.cell !== cell || target?.scope !== scope || target?.surface !== options.surface) {
      target = { id: crypto.randomUUID(), editor, kind, cell, scope, surface: options.surface,
        multiline: kind === "google-field" || kind === "dom" ? fieldMultiline(editor) : true };
    }
    snapshot(target);
    const fieldLabel = editor ? fieldName(editor) : "";
    let label;
    if (kind === "google-docs") label = "Google Docs 正文";
    else if (kind === "google-sheets") label = "Google Sheets · " + cell;
    else if (kind === "google-slides") label = options.surface === "notes" ? "Google Slides 演讲者备注" : "Google Slides 文本框";
    else label = (app ? app.name + " · " : "") + fieldLabel;
    notify({ type: "HT_TARGET", targetId: target.id, kind, app: app?.id || null,
      native: kind !== "dom", multiline: target.multiline, cell, surface: options.surface || "", label: label.slice(0, 80) });
  }
  function clearTarget() {
    if (nativeLock || session) return;
    target = null;
    notify({ type: "HT_CLEAR_TARGET" });
  }
  function captureSlides(node) {
    const el = node instanceof Element ? node : null;
    if (el?.closest("#speakernotes-workspace")) { remember(null, "google-slides", { surface: "notes" }); return; }
    if ((el?.closest(".pages") || el?.matches(".docs-texteventtarget-iframe")) && document.querySelector(".docs-text-selectionhandle")) {
      remember(null, "google-slides", { surface: "canvas" });
    }
  }
  function capture(node) {
    const el = node instanceof Element ? node : null;
    if (app?.id === "sheets" && el?.closest("#waffle-rich-text-editor,.grid-container,[id$='-grid-container']")) {
      remember(document.querySelector("#waffle-rich-text-editor"), "google-sheets"); return;
    }
    const editor = editorFor(node);
    if (editor) { remember(editor); return; }
    if (app?.id === "docs" && (el?.closest(".kix-appview-editor") || el?.matches(".docs-texteventtarget-iframe"))) {
      remember(null, "google-docs"); return;
    }
    if (app?.id === "slides") captureSlides(node);
  }
  const listen = (name, handler) => document.addEventListener(name, handler, { capture: true, signal: events.signal });
  listen("keydown", cancelNavigation);
  listen("keyup", () => {
    if (app?.id === "sheets" && !nativeLock && !session) capture(document.activeElement);
  });
  listen("pointerdown", event => {
    if (nativeLock && event.isTrusted) {
      notify({ type: "HT_NATIVE_CANCEL", runId: nativeLock.runId });
    }
  });
  listen("focusin", event => {
    const node = event.composedPath()[0];
    if (app?.id === "slides" && node?.matches?.(".docs-texteventtarget-iframe")) return;
    capture(node);
  });
  listen("pointerup", event => {
    const node = event.composedPath()[0];
    if (app?.id === "slides" && node instanceof Element && node.closest(".pages")) {
      clearTarget();
      const epoch = ++captureEpoch;
      setTimeout(() => { if (epoch === captureEpoch) captureSlides(node); }, 16);
    } else {
      capture(node); snapshot(target);
    }
  });
  listen("dblclick", event => {
    if (app?.id !== "slides") return;
    const node = event.composedPath()[0], epoch = ++captureEpoch;
    setTimeout(() => { if (epoch === captureEpoch) captureSlides(node); }, 16);
  });
  for (const name of ["selectionchange", "select", "keyup", "input", "focusout"]) {
    listen(name, () => { if (!session) snapshot(target); });
  }
  capture(document.activeElement);

  function restoreRange(record, editor) {
    if (!record.range) return;
    if (!editor.contains(record.range.startContainer) || !editor.contains(record.range.endContainer)) {
      throw new Error("网页编辑内容已变化，请重新选择输入位置。");
    }
    const selection = editor.ownerDocument.getSelection();
    selection.removeAllRanges(); selection.addRange(record.range.cloneRange());
  }
  function restore(record) {
    restoring = true;
    try {
      if (record.scope !== scopeKey()) throw new Error("文档、工作表或幻灯片已切换，请重新选择输入位置。");
      if (record.kind === "google-docs" || record.kind === "google-slides") {
        const input = bridgeInput();
        if (!input?.isContentEditable) throw new Error("找不到可编辑区域，请确认文件可编辑，并在正文或文本框中点选光标。");
        if (record.kind === "google-slides" && record.surface !== "notes" && !document.querySelector(".docs-text-selectionhandle")) {
          throw new Error("Slides 尚未进入文字编辑状态，请双击文本框，出现光标后重新选择。");
        }
        input.focus({ preventScroll: true });
        if (input.ownerDocument.activeElement !== input) throw new Error("Google 编辑器无法获得焦点，请重新选择输入位置。");
        return;
      }
      if (record.kind === "google-sheets") {
        if (cellReference() !== record.cell) throw new Error("当前单元格已改变，请重新选择。");
        const editor = document.querySelector("#waffle-rich-text-editor");
        if (!usable(editor)) throw new Error("单元格输入区域已失效，请重新选择。");
        record.editor = editor;
        editor.focus({ preventScroll: true });
        return;
      }
      const editor = record.editor;
      if (!usable(editor)) throw new Error("选中的输入框已移除或不可编辑，请重新选择。");
      editor.focus({ preventScroll: true });
      if (!textControl(editor) && !editor.isContentEditable) throw new Error("选中的输入区域已退出编辑状态，请重新选择。");
      if (textControl(editor)) {
        editor.setSelectionRange(record.start ?? editor.value.length, record.end ?? editor.value.length, record.direction || "none");
      } else if (record.range) restoreRange(record, editor);
      else throw new Error("尚未保存光标位置，请在目标输入区域点击一次。");
    } finally { restoring = false; }
  }
  function key(editor, type, value) {
    editor.dispatchEvent(new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true, composed: true }));
  }
  function edit(record, text, erase = false) {
    restore(record);
    const editor = record.editor;
    const inputType = erase ? "deleteContentBackward" : "insertText";
    const before = new InputEvent("beforeinput", {
      bubbles: true, composed: true, cancelable: true, inputType, data: erase ? null : text
    });
    if (textControl(editor)) {
      if (!editor.dispatchEvent(before)) throw new Error("网页拒绝了本次输入。");
      let start = editor.selectionStart;
      const end = editor.selectionEnd;
      if (erase && start === end) start = Math.max(0, start - 1);
      const next = editor.value.slice(0, start) + (erase ? "" : text) + editor.value.slice(end);
      if (editor.maxLength >= 0 && next.length > editor.maxLength) throw new Error("网页输入框自身的长度上限已达到。");
      const prototype = editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(editor, next);
      const caret = start + (erase ? 0 : text.length);
      editor.setSelectionRange(caret, caret);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: erase ? null : text }));
    } else {
      // execCommand keeps the browser's editing/undo behavior and emits input.
      if (!document.execCommand(erase ? "delete" : "insertText", false, erase ? undefined : text)) {
        throw new Error("此编辑器没有接受网页输入；Google Docs 请使用正文模式。");
      }
    }
    snapshot(record);
  }
  function progress(run, final = false) {
    notify({ type: "HT_DOM_PROGRESS", runId: run.id, running: !final, paused: !final && run.paused,
      sequence: ++run.sequence, completed: run.completed,
      total: run.chars.length, stopped: run.stopped, error: run.error || "" });
  }
  async function type(run) {
    let pendingTypo = false;
    try {
      for (const char of run.chars) {
        if (!await HTTyping.ready(run)) break;
        const wrongLetter = HTTyping.typo(run, char);
        if (wrongLetter) {
          edit(run.target, wrongLetter);
          pendingTypo = true;
          await HTTyping.sleep(run, HTTyping.correctionDelay());
          await HTTyping.ready(run);
          edit(run.target, "", true);
          pendingTypo = false;
          if (run.stopped) break;
          await HTTyping.sleep(run, HTTyping.afterCorrection());
        }
        if (!await HTTyping.ready(run)) break;
        key(run.target.editor, "keydown", char === "\n" ? "Enter" : char);
        edit(run.target, char);
        key(run.target.editor, "keyup", char === "\n" ? "Enter" : char);
        run.completed++;
        progress(run);
        if (run.completed < run.chars.length) {
          await HTTyping.sleep(run, HTTyping.delay(run, char));
        }
      }
    } catch (error) { run.error = error.message; run.stopped = true; }
    finally {
      if (pendingTypo) {
        try { edit(run.target, "", true); }
        catch (error) { run.error ||= "临时错字未能删除：" + error.message; run.stopped = true; }
      }
      if (session === run) { target = run.target; session = null; }
      progress(run, true);
    }
  }
  const handler = (message, sender, reply) => {
    try {
      if (message?.type === "HT_ARM") {
        if (session || nativeLock) throw new Error("请先停止正在进行的输入。");
        target = null; captureEpoch++; reply({ ok: true });
      } else if (message?.type === "HT_NATIVE_BEGIN") {
        if (session || nativeLock) throw new Error("当前输入仍在进行，请先停止。");
        if (!target || target.id !== message.targetId || target.kind === "dom") throw new Error("输入目标已变化，请重新选择。");
        nativeLock = { runId: message.runId, targetId: target.id };
        try {
          restore(target);
          reply({ ok: true, kind: target.kind,
            enterEdit: target.kind === "google-sheets" && !cellEditing(target.editor) });
        } catch (error) { nativeLock = null; throw error; }
      } else if (message?.type === "HT_NATIVE_READY") {
        if (!nativeLock || nativeLock.runId !== message.runId) throw new Error("输入连接已失效。");
        if (target.kind === "google-sheets" && !cellEditing(target.editor)) {
          throw new Error("单元格未进入编辑状态，可能处于只读或保护模式。请先双击单元格再选择。");
        }
        snapshot(target); reply({ ok: true });
      } else if (message?.type === "HT_FOCUS") {
        if (!target || (message.targetId && target.id !== message.targetId)) throw new Error("输入目标已变化，请重新选择。");
        if (message.runId && nativeLock?.runId !== message.runId) throw new Error("输入连接已失效。");
        restore(target); reply({ ok: true, kind: target.kind });
      } else if (message?.type === "HT_NATIVE_BEFORE") {
        if (nativeLock?.runId !== message.runId || target?.id !== message.targetId) throw new Error("输入目标已变化。");
        const editor = target.editor;
        if (textControl(editor) && editor.maxLength >= 0 &&
          editor.value.length - (editor.selectionEnd - editor.selectionStart) + String(message.text || "").length > editor.maxLength) {
          throw new Error("网页输入框自身的长度上限已达到。");
        }
        reply({ ok: true });
      } else if (message?.type === "HT_NATIVE_AFTER") {
        if (nativeLock?.runId !== message.runId || target?.id !== message.targetId) throw new Error("输入目标已变化。");
        snapshot(target); reply({ ok: true });
      } else if (message?.type === "HT_NATIVE_END") {
        if (nativeLock?.runId === message.runId) { snapshot(target); nativeLock = null; }
        reply({ ok: true });
      } else if (message?.type === "HT_DOM_START") {
        if (session || nativeLock) throw new Error("当前输入仍在进行，请先停止。");
        if (!target || target.kind !== "dom" || (message.targetId && message.targetId !== target.id)) throw new Error("请重新选择网页输入框。");
        restore(target);
        const chars = Array.from(String(message.text || "").replace(/\r\n?/g, "\n"));
        if (!chars.length) throw new Error("没有可输入的文本。");
        const run = { id: message.runId, target: { ...target, range: target.range?.cloneRange() }, chars,
          speed: Math.max(0, Math.min(100, Number(message.speed) || 0)), human: message.humanMode === true,
          completed: 0, paused: false, sequence: 0, stopped: false, wake: null };
        session = run; reply({ ok: true }); void type(run);
      } else if (message?.type === "HT_DOM_PAUSE") {
        if (!session || session.id !== message.runId || session.stopped) throw new Error("输入任务已结束。");
        session.paused = message.paused === true; session.wake?.(); progress(session);
        reply({ ok: true, paused: session.paused, runId: session.id });
      } else if (message?.type === "HT_DOM_STOP") {
        if (session) { session.stopped = true; session.wake?.(); } reply({ ok: true });
      }
    } catch (error) { reply({ ok: false, error: error.message }); }
    return false;
  };
  chrome.runtime.onMessage.addListener(handler);
  globalThis.__humanTyper = {
    version: VERSION,
    dispose() {
      events.abort(); captureEpoch++;
      if (session) { session.stopped = true; session.wake?.(); }
      if (nativeLock) notify({ type: "HT_NATIVE_CANCEL", runId: nativeLock.runId });
      chrome.runtime.onMessage.removeListener(handler);
    }
  };
})();
