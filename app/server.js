'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./lib/config');
const store = require('./lib/store');
const servers = require('./lib/servers');
const runs = require('./lib/runs');
const jobs = require('./lib/jobs');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
};
const ALLOWED_HOSTS = new Set([`127.0.0.1:${config.PORT}`, `localhost:${config.PORT}`]);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function sendFile(res, file, extraHeaders = {}) {
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) reject(Object.assign(new Error('Request too large'), { status: 413 }));
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function streamRun(req, res, id) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const writeLines = (text) => { for (const line of text.split('\n')) if (line) write('line', line.replace(/\r$/, '')); };
  const emitter = runs.subscribe(id);

  if (emitter) {
    // Running in this process: past lines from the file, new ones from the emitter.
    writeLines(runs.readLog(id, 0, true).text);
    const onLine = (line) => write('line', line);
    const onEnd = (meta) => { write('end', meta); res.end(); };
    emitter.on('line', onLine);
    emitter.once('end', onEnd);
    req.on('close', () => { emitter.off('line', onLine); emitter.off('end', onEnd); });
    return;
  }

  const meta = runs.readMeta(id);
  if (meta.status !== 'running') {
    writeLines(runs.readLog(id, 0, true).text);
    write('end', meta);
    return res.end();
  }

  // Running in another process (a scheduled job): follow the log file until the run finishes.
  let { text, next } = runs.readLog(id);
  writeLines(text);
  const timer = setInterval(() => {
    try {
      const current = runs.readMeta(id);
      const done = current.status !== 'running';
      ({ text, next } = runs.readLog(id, next, done));
      writeLines(text);
      if (done) {
        clearInterval(timer);
        write('end', current);
        res.end();
      }
    } catch (err) {
      clearInterval(timer);
      res.end();
    }
  }, 1500);
  req.on('close', () => clearInterval(timer));
}

// [method, pattern, handler(match, body, req, res)] -- a handler returns JSON or handles res itself.
const routes = [
  ['GET', /^\/api\/servers$/, () => servers.list()],
  ['POST', /^\/api\/servers$/, (m, body) => servers.save(body)],
  ['POST', /^\/api\/servers\/test$/, (m, body) => servers.testDefinition(body)],
  ['DELETE', /^\/api\/servers\/([^/]+)$/, (m) => { servers.remove(decodeURIComponent(m[1])); return { ok: true }; }],
  ['GET', /^\/api\/servers\/([^/]+)\/databases$/, (m) => servers.listDatabases(decodeURIComponent(m[1]))],

  ['GET', /^\/api\/runs$/, () => runs.list()],
  ['POST', /^\/api\/runs$/, (m, body) => ({ id: runs.start(body).id })],
  ['GET', /^\/api\/runs\/([^/]+)$/, (m) => runs.readMeta(m[1])],
  ['DELETE', /^\/api\/runs\/([^/]+)$/, (m) => { runs.remove(m[1]); return { ok: true }; }],
  ['GET', /^\/api\/runs\/([^/]+)\/events$/, (m, body, req, res) => streamRun(req, res, m[1])],

  ['GET', /^\/api\/snapshots$/, () => runs.listSnapshots()],

  ['GET', /^\/api\/jobs$/, () => jobs.list()],
  ['POST', /^\/api\/jobs$/, (m, body) => jobs.save(body)],
  ['DELETE', /^\/api\/jobs\/([^/]+)$/, async (m) => { await jobs.remove(m[1]); return { ok: true }; }],
  ['POST', /^\/api\/jobs\/([^/]+)\/run$/, (m) => ({ id: jobs.runNow(m[1]).id })],
];

async function handle(req, res) {
  // Rejects other hosts (DNS rebinding) and cross-site writes: browsers cannot add a custom
  // header to a cross-origin request without a CORS preflight, which this server never answers.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
  if (req.method !== 'GET' && req.headers['x-database-diff'] !== '1') return send(res, 403, { error: 'Missing request header' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURI(url.pathname);

  if (pathname.startsWith('/api/')) {
    const route = routes.find(([method, re]) => method === req.method && re.test(pathname));
    if (!route) return send(res, 404, { error: 'Not found' });
    const body = req.method === 'GET' ? {} : await readBody(req);
    const result = await route[2](pathname.match(route[1]), body, req, res);
    if (!res.headersSent) send(res, 200, result === undefined ? { ok: true } : result);
    return;
  }

  // Reports and snapshots of a run: /runs/<id>/<file>
  const runFile = /^\/runs\/([^/]+)\/(.+)$/.exec(pathname);
  if (runFile && req.method === 'GET') {
    const download = url.searchParams.get('download') === '1';
    const headers = download ? { 'Content-Disposition': `attachment; filename="${path.basename(runFile[2]).replace(/"/g, '')}"` } : {};
    return sendFile(res, runs.file(runFile[1], runFile[2]), headers);
  }

  if (req.method === 'GET') {
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = store.safeJoin(config.PUBLIC, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file);
  }
  send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) return res.end();
    send(res, err.status || 500, { error: err.message });
  });
});

// nodemon restarts this script on every code change; open the browser only once per parent
// process (one nodemon or one start.cmd console), not on each restart.
function openBrowserOnce(url) {
  store.ensureDir(config.TMP);
  const marker = path.join(config.TMP, `opened-${process.ppid}`);
  if (fs.existsSync(marker)) return;
  for (const old of fs.readdirSync(config.TMP).filter((f) => f.startsWith('opened-'))) fs.rmSync(path.join(config.TMP, old), { force: true });
  fs.writeFileSync(marker, url);
  spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true }).unref();
}

server.listen(config.PORT, config.HOST, () => {
  const url = `http://${config.HOST}:${config.PORT}/`;
  console.log(`database-diff is running at ${url}  (Ctrl+C to stop)`);
  if (process.argv.includes('--open')) openBrowserOnce(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${config.PORT} is in use. Is database-diff already running? Set PORT to use another port.`);
  else console.error(err.message);
  process.exit(1);
});
