'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const { runPowerShell } = require('./powershell');

// Server ids: "local" (localhost, Windows auth), "app:<slug>" (saved from the web UI, password
// encrypted with DPAPI) and "mcp:<name>" (read-only .env profiles of the mssql-mcp server).
const LOCAL = {
  id: 'local',
  kind: 'builtin',
  name: 'localhost',
  server: 'localhost',
  port: null,
  auth: 'windows',
  user: '',
  readOnly: true,
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseEnvFile(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return values;
}

function listDir(dir, ext) {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function fromAppProfile(file) {
  const p = store.readJson(path.join(config.SERVERS, file));
  return {
    id: `app:${path.basename(file, '.json')}`,
    kind: 'app',
    name: p.name,
    server: p.server,
    port: p.port || null,
    auth: p.user ? 'sql' : 'windows',
    user: p.user || '',
    hasPassword: Boolean(p.password),
    encrypt: Boolean(p.encrypt),
    trustServerCertificate: Boolean(p.trustServerCertificate),
    readOnly: false,
  };
}

function fromMcpProfile(file) {
  const v = parseEnvFile(path.join(config.MCP_PROFILES, file));
  return {
    id: `mcp:${path.basename(file, '.env')}`,
    kind: 'mcp',
    name: path.basename(file, '.env'),
    server: v.MSSQL_SERVER || '',
    port: v.MSSQL_PORT ? Number(v.MSSQL_PORT) : null,
    auth: v.MSSQL_USER ? 'sql' : 'windows',
    user: v.MSSQL_USER || '',
    encrypt: v.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: v.MSSQL_TRUST_CERT === 'true',
    readOnly: true,
  };
}

function list() {
  const servers = [LOCAL];
  for (const file of listDir(config.SERVERS, '.json')) servers.push(fromAppProfile(file));
  for (const file of listDir(config.MCP_PROFILES, '.env')) {
    const s = fromMcpProfile(file);
    if (s.server) servers.push(s);
  }
  return servers;
}

function get(id) {
  const server = list().find((s) => s.id === id);
  if (!server) throw httpError(404, `Unknown server: ${id}`);
  return server;
}

function label(id) {
  const s = get(id);
  const address = s.port ? `${s.server},${s.port}` : s.server;
  return s.kind === 'builtin' ? address : `${s.name} (${address})`;
}

function profilePath(id) {
  if (id.startsWith('app:')) return store.safeJoin(config.SERVERS, `${id.slice(4)}.json`);
  if (id.startsWith('mcp:')) return store.safeJoin(config.MCP_PROFILES, `${id.slice(4)}.env`);
  return null;
}

// Engine arguments that select a server for one side ("Source" or "Target").
function engineArgs(id, side) {
  get(id);
  if (id === 'local') return [`-${side}Server`, 'localhost'];
  return [`-${side}Profile`, profilePath(id)];
}

// DPAPI (CurrentUser): only this Windows user on this machine can decrypt the result, which is
// also the account the scheduled tasks run as. The password travels over stdin, never argv.
async function protect(plain) {
  if (!plain) return '';
  const script = '$p = [Console]::In.ReadToEnd(); ConvertTo-SecureString $p -AsPlainText -Force | ConvertFrom-SecureString';
  const { code, stdout, stderr } = await runPowerShell(['-Command', script], { input: plain });
  if (code !== 0 || !stdout.trim()) throw new Error(`Could not encrypt the password: ${stderr.trim()}`);
  return stdout.trim();
}

function validate(def) {
  const name = String(def.name || '').trim();
  const server = String(def.server || '').trim();
  if (!name) throw httpError(400, 'Name is required');
  if (!server || /[\s;'"]/.test(server)) throw httpError(400, 'Server host is invalid');
  const port = def.port === '' || def.port == null ? null : Number(def.port);
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw httpError(400, 'Port is invalid');
  const auth = def.auth === 'sql' ? 'sql' : 'windows';
  const user = auth === 'sql' ? String(def.user || '').trim() : '';
  if (auth === 'sql' && !user) throw httpError(400, 'User is required for SQL login');
  return { name, server, port, auth, user };
}

async function buildProfile(def, existing) {
  const v = validate(def);
  let password = '';
  if (v.auth === 'sql') {
    if (def.password) password = await protect(String(def.password));
    else if (existing && existing.user) password = existing.password || '';
  }
  return {
    name: v.name,
    server: v.server,
    port: v.port,
    user: v.user,
    password,
    encrypt: Boolean(def.encrypt),
    trustServerCertificate: Boolean(def.trustServerCertificate),
  };
}

function slugify(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
  let slug = base;
  for (let i = 2; fs.existsSync(path.join(config.SERVERS, `${slug}.json`)); i++) slug = `${base}-${i}`;
  return slug;
}

async function save(def) {
  let slug;
  let existing = null;
  if (def.id) {
    if (!def.id.startsWith('app:')) throw httpError(400, 'Only servers created here can be edited');
    slug = def.id.slice(4);
    if (!SLUG.test(slug)) throw httpError(400, 'Invalid server id');
    existing = store.readJson(path.join(config.SERVERS, `${slug}.json`), null);
    if (!existing) throw httpError(404, `Unknown server: ${def.id}`);
  } else {
    slug = slugify(String(def.name || ''));
  }
  const profile = await buildProfile(def, existing);
  store.writeJson(path.join(config.SERVERS, `${slug}.json`), profile);
  return get(`app:${slug}`);
}

function remove(id) {
  if (!id.startsWith('app:')) throw httpError(400, 'Only servers created here can be deleted');
  const file = profilePath(id);
  if (!fs.existsSync(file)) throw httpError(404, `Unknown server: ${id}`);
  fs.unlinkSync(file);
}

async function listDatabasesWithProfile(profileArgs) {
  const { stdout, stderr } = await runPowerShell(['-File', config.ENGINE, '-ListDatabases', ...profileArgs]);
  let result;
  try {
    result = JSON.parse(stdout.replace(/^﻿/, ''));
  } catch {
    throw new Error(`Unexpected engine output: ${(stdout || stderr).trim().slice(0, 500)}`);
  }
  if (result.error) throw httpError(502, result.error);
  return result;
}

function listDatabases(id) {
  return listDatabasesWithProfile(engineArgs(id, 'Source'));
}

// Tests a definition that is not saved yet; the temporary profile keeps the password encrypted.
async function testDefinition(def) {
  let existing = null;
  if (def.id && def.id.startsWith('app:')) existing = store.readJson(profilePath(def.id), null);
  const profile = await buildProfile(def, existing);
  store.ensureDir(config.TMP);
  const tmp = path.join(config.TMP, `test-${process.pid}-${Date.now()}.json`);
  store.writeJson(tmp, profile);
  try {
    return await listDatabasesWithProfile(['-SourceProfile', tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { list, get, label, engineArgs, save, remove, listDatabases, testDefinition };
