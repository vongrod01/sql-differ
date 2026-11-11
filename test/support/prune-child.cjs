// Runs retention.prune in a process of its own, for test/retention.test.ts: the app reads its
// data folder from the environment when it is loaded, so every scenario needs its own process.
// Usage: node prune-child.cjs '<JSON options of prune>' ; prints "RESULT:" and JSON as its last line.
'use strict';

const path = require('path');
const config = require('../../app/lib/config.js');

// Deleting is final: this script only ever works on a scratch folder of the retention tests.
const scratch = path.join(__dirname, '..', '.out') + path.sep + 'retention-';
if (!path.resolve(config.DATA).startsWith(scratch)) {
  console.error(`prune-child.cjs refuses to run on ${config.DATA}: not a retention test folder`);
  process.exit(3);
}

const retention = require('../../app/lib/retention.js');
const options = JSON.parse(process.argv[2] || '{}');
const result = options.skip ? null : retention.prune(options);
console.log(`RESULT:${JSON.stringify({ result, days: config.RETENTION_DAYS, invalid: config.RETENTION_INVALID, keep: config.RETENTION_KEEP })}`);
