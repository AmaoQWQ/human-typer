(() => {
  const apps = [
    { id: "docs", name: "Google Docs", host: "docs.google.com", path: "/document/", hint: "点击文档正文中的输入位置。标题和评论也可单独选择。" },
    { id: "sheets", name: "Google Sheets", host: "docs.google.com", path: "/spreadsheets/", hint: "选择一个单元格。换行保留在同一格，输入后可按 Enter 确认。" },
    { id: "slides", name: "Google Slides", host: "docs.google.com", path: "/presentation/", hint: "双击文本框，出现光标后再回到侧栏。演讲者备注可直接点击。" },
    { id: "forms", name: "Google Forms", host: "docs.google.com", path: "/forms/", hint: "点击要填写的文字题输入框，或表单编辑器中的文字字段。" },
    { id: "gmail", name: "Gmail", host: "mail.google.com", hint: "点击邮件主题或正文输入位置。输入完成后由你点击发送。" },
    { id: "keep", name: "Google Keep", host: "keep.google.com", hint: "打开记事，再点击标题或正文。" },
    { id: "drive", name: "Google Drive", host: "drive.google.com", hint: "点击搜索框、重命名框或其他文字输入框。" }
  ];
  const canvasKinds = new Set(["google-docs", "google-sheets", "google-slides"]);
  function match(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:") return null;
      return apps.find(app => app.host === url.hostname && (!app.path || url.pathname.startsWith(app.path))) || null;
    } catch { return null; }
  }
  function nativeKind(kind) { return canvasKinds.has(kind) || kind === "google-field"; }
  function routeMatches(route, url) {
    const app = match(url);
    if (!app || app.id !== route.app) return false;
    if (route.kind === "google-field") return true;
    return route.kind === "google-" + app.id && canvasKinds.has(route.kind);
  }
  globalThis.HTGoogleApps = Object.freeze({ apps: Object.freeze(apps), match, nativeKind, routeMatches });
})();
