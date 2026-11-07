// Serves out/ so the webview bundle can be inspected in a browser.
// Dev-only: never shipped, never referenced by the extension.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('out');
const PORT = Number(process.env.PORT ?? 5174);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'preview.html' : rel);
  // Never serve outside out/.
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`preview on http://localhost:${PORT}`));
