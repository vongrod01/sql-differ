// Starts the web app (app/server.js) as a process of its own for a test, on a free port: never on
// the app's own 4870, and only over the scratch folders the environment names.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { ROOT } from './engine.js';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

// Runs `use` against a server and stops it. `env`: environment variables on top of this
// process's. DATABASE_DIFF_DATA must be set, here or in the process: the server cleans up old
// runs when it starts, and that must never be the real data folder.
// Two variables are not taken from this process, only from `env`: a test says itself when its
// server deletes old runs (DATABASE_DIFF_RETENTION_DAYS; 0, never, when it does not say), and
// whether it runs as under node --watch (WATCH_REPORT_DEPENDENCIES, which the shell of a
// developer may well have set).
export async function withServer<T>(use: (base: string) => Promise<T>, env: Record<string, string> = {}): Promise<T> {
  const all: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(all)) {
    if (['DATABASE_DIFF_RETENTION_DAYS', 'WATCH_REPORT_DEPENDENCIES'].includes(key.toUpperCase())) delete all[key];
  }
  Object.assign(all, { DATABASE_DIFF_RETENTION_DAYS: '0' }, env);
  assert.ok(all['DATABASE_DIFF_DATA'], 'a test server needs DATABASE_DIFF_DATA');
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js')], { env: { ...all, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        up = (await fetch(`${base}/api/jobs`, { headers: { 'x-database-diff': '1' } })).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(up, 'app/server.js did not start');
    return await use(base);
  } finally {
    server.kill();
  }
}
