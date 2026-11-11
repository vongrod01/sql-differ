'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

// Write to a temp file first so a crash never leaves half a JSON file behind.
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Resolves `name` inside `dir` and refuses anything that escapes it.
function safeJoin(dir, name) {
  const full = path.resolve(dir, name);
  const root = path.resolve(dir) + path.sep;
  if (!full.startsWith(root)) throw Object.assign(new Error('Invalid path'), { status: 400 });
  return full;
}

module.exports = { ensureDir, readJson, writeJson, safeJoin };
