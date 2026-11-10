// Zero-dependency static server for the built demo (dist/). Usage: node scripts/serve.mjs dist 5173
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const root = process.argv[2] || 'dist';
const port = Number(process.argv[3] || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.gz': 'application/gzip', '.json': 'application/json' };

createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p.endsWith('/')) p += 'index.html';
  const file = join(root, p);
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => `http://${n.address}:${port}/`);
  console.log(`\nLA&9S 演示版已启动\n  电脑打开：http://localhost:${port}/`);
  if (lan.length) console.log(`  手机（连同一个 Wi-Fi）打开：${lan.join('  或  ')}`);
  console.log('  关闭这个窗口即停止。演示版只放虚构数据。\n');
});
