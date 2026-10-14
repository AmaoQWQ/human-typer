const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
http.createServer((request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
  catch { response.writeHead(400).end(); return; }
  if (pathname === '/tests/panel.html') {
    const markup = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8')
      .replace('href="sidepanel.css"', 'href="../sidepanel.css"')
      .replace('<script src="sidepanel.js"></script>', '<script src="panel-mock.js"></script><script src="../sidepanel.js"></script>');
    response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(markup); return;
  }
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(404).end(); return; }
    const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/html';
    response.setHeader('Content-Type', mime + (mime.startsWith('text/') ? '; charset=utf-8' : ''));
    response.end(data);
  });
}).listen(8766, '127.0.0.1', () => console.log('Test fixture ready: http://127.0.0.1:8766/tests/focus.html'));
