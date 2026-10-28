// Rewrites test/golden from the current engine output. Review the git diff afterwards: a golden
// file is only as right as the output it was taken from.
import { spawnSync } from 'node:child_process';

const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/engine.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, UPDATE_GOLDEN: '1' },
});
process.exit(run.status ?? 1);
