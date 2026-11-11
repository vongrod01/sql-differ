// The scrubbing that makes engine output comparable between runs and machines (test/support/golden.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubJson } from './support/golden.js';
import { query, skipWithoutServer } from './support/sql.js';

const skip = skipWithoutServer();

// What SERVERPROPERTY('ServerName') answers is in the results and snapshots as "serverName". It is
// the machine name, or on LocalDB the machine name and a name with a hash that changes whenever
// the instance starts. Replacing that text wherever it stands would also hit a login of that
// machine, a path that holds its name or a label; and a value read before the instance restarted
// would not be found at all.
test('golden: the server that answered is scrubbed by its key, not by its text', { skip }, () => {
  const live = query("SELECT CAST(SERVERPROPERTY('ServerName') AS nvarchar(128))").output.trim();
  assert.ok(live, 'the test server has a name');
  const scrubbed = JSON.parse(scrubJson({
    source: { label: 'kept', serverName: 'ANOTHER-PC\\LOCALDB#0000AAAA' },
    target: { label: 'kept', serverName: live },
    // A side read from a snapshot saved before the engine recorded the name.
    old: { serverName: '' },
    items: [{ serverName: live }],
    note: `${live} is only text here`,
  })) as Record<string, unknown>;
  assert.deepEqual(scrubbed, {
    source: { label: 'kept', serverName: '<servername>' },
    target: { label: 'kept', serverName: '<servername>' },
    old: { serverName: '' },
    items: [{ serverName: '<servername>' }],
    note: `${live} is only text here`,
  });
});
