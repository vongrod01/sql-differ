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
const retention = require('./lib/retention');

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

// Headers go out only once the file is open, so a file that cannot be read (deleted, locked by an
// antivirus) gets an error response instead of an unhandled stream error that stops the server.
function sendFile(res, file, extraHeaders = {}) {
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const stream = fs.createReadStream(file);
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
    stream.pipe(res);
  });
  stream.on('error', (err) => {
    if (!res.headersSent) send(res, err.code === 'ENOENT' ? 404 : 500, { error: err.code === 'ENOENT' ? 'Not found' : 'Could not read the file' });
    else res.destroy();
  });
  res.on('close', () => stream.destroy());
}

// RFC 6266: an ASCII fallback plus the real (often Thai) name; a raw non-Latin-1 header value
// makes Node throw.
function attachmentHeader(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error('Malformed URL'), { status: 400 });
  }
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
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
      // Every handler reads fields of an object; null, arrays and numbers are not requests.
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(Object.assign(new Error('The request body must be a JSON object'), { status: 400 }));
      resolve(body);
    });
    req.on('error', reject);
  });
}

function streamRun(req, res, id) {
  const entry = runs.subscribe(id);
  // Unknown or invalid ids get a 400/404 here, before the stream starts.
  const meta = entry ? null : runs.readMeta(id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const writeLines = (text) => { for (const line of text.split('\n')) if (line.trim()) write('line', line.replace(/\r$/, '')); };

  if (entry) {
    // Running in this process: past lines from memory, then new ones from the emitter. Both
    // happen in this tick, so no line falls between them.
    for (const line of entry.lines) write('line', line);
    const onLine = (line) => write('line', line);
    const onEnd = (final) => { write('end', final); res.end(); };
    entry.emitter.on('line', onLine);
    entry.emitter.once('end', onEnd);
    req.on('close', () => { entry.emitter.off('line', onLine); entry.emitter.off('end', onEnd); });
    return;
  }

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
  // The check for jobs is made here, not in servers.js: jobs.js needs runs.js, which needs servers.js.
  ['DELETE', /^\/api\/servers\/([^/]+)$/, (m) => {
    const id = decodeParam(m[1]);
    const used = jobs.usingServer(id);
    if (used.length) {
      const names = used.map((j) => `"${j.name}"`).join(', ');
      const message = used.length === 1
        ? `This server is used by the scheduled job ${names}. Change or delete that job first.`
        : `This server is used by the scheduled jobs ${names}. Change or delete those jobs first.`;
      throw Object.assign(new Error(message), { status: 409 });
    }
    servers.remove(id);
    return { ok: true };
  }],
  ['GET', /^\/api\/servers\/([^/]+)\/databases$/, (m) => servers.listDatabases(decodeParam(m[1]))],

  ['GET', /^\/api\/runs$/, () => runs.list()],
  // Only Task Scheduler and the "run now" button may tie a run to a job.
  ['POST', /^\/api\/runs$/, (m, body) => ({ id: runs.start({ ...body, trigger: 'manual', jobId: null, jobName: null }).id })],
  ['GET', /^\/api\/runs\/([^/]+)$/, (m) => runs.readMeta(m[1])],
  // The size of the history is kept for a few minutes: forgotten here, so the page shows the new one.
  ['DELETE', /^\/api\/runs\/([^/]+)$/, (m) => { runs.remove(m[1]); retention.forgetUsage(); return { ok: true }; }],
  ['GET', /^\/api\/runs\/([^/]+)\/events$/, (m, body, req, res) => streamRun(req, res, m[1])],

  ['GET', /^\/api\/snapshots$/, () => runs.listSnapshots()],
  // Size of the run history and how long it is kept, for the history page.
  ['GET', /^\/api\/storage$/, () => retention.usage()],

  ['GET', /^\/api\/jobs$/, () => jobs.list()],
  ['POST', /^\/api\/jobs$/, (m, body) => jobs.save(body)],
  ['DELETE', /^\/api\/jobs\/([^/]+)$/, async (m) => { await jobs.remove(m[1]); return { ok: true }; }],
  ['POST', /^\/api\/jobs\/([^/]+)\/run$/, (m) => ({ id: jobs.runNow(m[1], 'manual').id })],
];

const SSE_ROUTE = /^\/api\/runs\/[^/]+\/events$/;

async function handle(req, res) {
  // Rejects other hosts (DNS rebinding) and cross-site requests to the API: browsers cannot add a
  // custom header to a cross-origin request without a CORS preflight, which this server never
  // answers. EventSource cannot send headers, so the event stream relies on Sec-Fetch-Site, which
  // every current browser sends. GETs need this too: listing databases starts an engine process
  // and logs in to the stored server, so an <img> on another site must not trigger it.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname;
  try {
    pathname = decodeURI(url.pathname);
  } catch {
    return send(res, 400, { error: 'Malformed URL' });
  }

  if (pathname.startsWith('/api/')) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'Cross-site request' });
    const isStream = req.method === 'GET' && SSE_ROUTE.test(pathname);
    if (!isStream && req.headers['x-database-diff'] !== '1') return send(res, 403, { error: 'Missing request header' });
    const route = routes.find(([method, re]) => method === req.method && re.test(pathname));
    if (!route) return send(res, 404, { error: 'Not found' });
    const body = req.method === 'GET' ? {} : await readBody(req);
    const result = await route[2](pathname.match(route[1]), body, req, res);
    if (!res.headersSent) send(res, 200, result === undefined ? { ok: true } : result);
    return;
  }

  const download = url.searchParams.get('download') === '1';

  // Every database's sync or rollback script of a batch run in one file: /runs/<id>/combined/<kind>.sql
  // The engine writes no folders into a run, so this path never names a real file.
  const combined = /^\/runs\/([^/]+)\/combined\/(sync|rollback)\.sql$/.exec(pathname);
  if (combined && req.method === 'GET') {
    const { name, text } = runs.combinedScript(combined[1], combined[2]);
    res.writeHead(200, {
      'Content-Type': TYPES['.sql'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(download ? { 'Content-Disposition': attachmentHeader(name) } : {}),
    });
    return res.end(text);
  }

  // Reports and snapshots of a run: /runs/<id>/<file>
  const runFile = /^\/runs\/([^/]+)\/(.+)$/.exec(pathname);
  if (runFile && req.method === 'GET') {
    const headers = download ? { 'Content-Disposition': attachmentHeader(path.basename(runFile[2])) } : {};
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
  // No response of this app may be shown in a frame, by any site: its pages start runs and delete
  // history at a click, and a page that frames them invisibly can make the user click
  // (clickjacking). Set here, before anything answers, so that every way out carries them: JSON,
  // files, the event stream, combined scripts, errors. Both headers: frame-ancestors is the
  // current one, X-Frame-Options is what older browsers read.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  handle(req, res).catch((err) => {
    if (res.headersSent) return res.end();
    send(res, err.status || 500, { error: err.message });
  });
});

// "npm run dev" (node --watch-path) restarts this script on every code change; open the browser
// only once per parent process (one watcher or one start.cmd console), not on each restart.
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
  // Deletes runs older than the retention period now, and once a day while the server runs
  // (not under node --watch: see retention.schedule).
  retention.schedule();
  if (process.argv.includes('--open')) openBrowserOnce(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${config.PORT} is in use. Is database-diff already running? Set PORT to use another port.`);
  else console.error(err.message);
  process.exit(1);
});
