'use strict';

const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = process.env.DATABASE_DIFF_DATA || path.join(ROOT, 'data');

// How long the run history is kept (lib/retention.js deletes older runs). The variable
// DATABASE_DIFF_RETENTION_DAYS: not set = 90 days; 0 = nothing is deleted automatically; anything
// that is not a whole number of days = nothing is deleted either, and the server says so when it
// starts. A mistyped value must not start deleting history, nor quietly turn into 90.
function retention(value) {
  const text = value === undefined ? '' : String(value).trim();
  if (text === '') return { days: 90, invalid: '' };
  if (/^\d{1,5}$/.test(text)) return { days: Number(text), invalid: '' };
  return { days: 0, invalid: text };
}
const RETENTION = retention(process.env.DATABASE_DIFF_RETENTION_DAYS);

module.exports = {
  ROOT,
  DATA,
  RUNS: path.join(DATA, 'runs'),
  SERVERS: path.join(DATA, 'servers'),
  TMP: path.join(DATA, 'tmp'),
  JOBS_FILE: path.join(DATA, 'jobs.json'),
  ENGINE: path.join(ROOT, 'Compare-Database.ps1'),
  // Read-only: connection profiles the mssql-mcp server already uses on this machine. The
  // variable is for the tests, which must not read them: it also reaches the processes they start.
  MCP_PROFILES: process.env.DATABASE_DIFF_MCP_PROFILES || path.join(os.homedir(), '.config', 'mssql-mcp'),
  PUBLIC: path.join(__dirname, '..', 'public'),
  HOST: '127.0.0.1',
  PORT: Number(process.env.PORT) || 4870,
  TASK_FOLDER: 'database-diff',
  // Runs older than this many days are deleted automatically; 0 = never.
  RETENTION_DAYS: RETENTION.days,
  // The text of the variable when it is not a number of days (retention is off then), else ''.
  RETENTION_INVALID: RETENTION.invalid,
  // The newest runs that are kept whatever their age.
  RETENTION_KEEP: 20,
  RETENTION_LOG: path.join(DATA, 'retention.log'),
};
