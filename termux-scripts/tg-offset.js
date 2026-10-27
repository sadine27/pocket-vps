// tg-offset.js — tiny state keeper for Telegram getUpdates offset (file-backed)
const http = require('http');
const fs = require('fs');
const F = '/data/data/com.termux/files/home/server/tg-offset.json';
const read = () => { try { return JSON.parse(fs.readFileSync(F, 'utf8')); } catch (e) { return { offset: 0 }; } };
const write = (o) => fs.writeFileSync(F, JSON.stringify(o));
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/offset') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(read()));
    return;
  }
  if (req.method === 'POST' && req.url === '/offset') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        const n = JSON.parse(b);
        const cur = read();
        cur.offset = Math.max(cur.offset || 0, Number(n.offset) || 0);
        write(cur);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cur));
      } catch (e) {
        res.statusCode = 400;
        res.end('bad json');
      }
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(8090, '127.0.0.1', () => console.log('tg-offset on 127.0.0.1:8090'));
