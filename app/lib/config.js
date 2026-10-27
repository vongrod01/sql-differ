'use strict';

const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = process.env.DATABASE_DIFF_DATA || path.join(ROOT, 'data');

module.exports = {
  ROOT,
  DATA,
  RUNS: path.join(DATA, 'runs'),
  SERVERS: path.join(DATA, 'servers'),
  TMP: path.join(DATA, 'tmp'),
  JOBS_FILE: path.join(DATA, 'jobs.json'),
  ENGINE: path.join(ROOT, 'Compare-Database.ps1'),
  // Read-only: connection profiles the mssql-mcp server already uses on this machine.
  MCP_PROFILES: path.join(os.homedir(), '.config', 'mssql-mcp'),
  PUBLIC: path.join(__dirname, '..', 'public'),
  HOST: '127.0.0.1',
  PORT: Number(process.env.PORT) || 4870,
  TASK_FOLDER: 'database-diff',
};
