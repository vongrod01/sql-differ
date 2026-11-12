// Loaded into the web app of a test before anything else (NODE_OPTIONS=--require), for
// test/retention.test.ts: makes one file-system call of the delete of a run fail, which no test
// can bring about from outside (Windows refuses the rename of a folder as long as any file in it
// is open, so "renamed, but its files cannot be deleted" does not happen on demand).
// DATABASE_DIFF_TEST_FS_FAULT:
//   delete: deleting a folder named "deleted-..." fails as a file in use does (EPERM);
//   rename: renaming a run folder fails with an error that is not "in use", whose message
//           names both paths, as the real ones do.
'use strict';

const fs = require('fs');
const path = require('path');

const fault = process.env.DATABASE_DIFF_TEST_FS_FAULT || '';
// Only ever in a scratch folder of the retention tests.
const scratch = path.join(__dirname, '..', '.out') + path.sep + 'retention-';
const data = path.resolve(process.env.DATABASE_DIFF_DATA || '');
if (fault && !data.startsWith(scratch)) {
  console.error('fs-fault.cjs refuses to run on ' + data + ': not a retention test folder');
  process.exit(3);
}

if (fault === 'delete') {
  const rmSync = fs.rmSync;
  fs.rmSync = function (target, options) {
    if (path.basename(String(target)).startsWith('deleted-')) {
      throw Object.assign(new Error("EPERM, Permission denied: '" + target + "'"), { code: 'EPERM', path: String(target) });
    }
    return rmSync.call(fs, target, options);
  };
}

if (fault === 'rename') {
  const renameSync = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (path.dirname(path.resolve(String(from))) === path.join(data, 'runs')) {
      throw Object.assign(new Error("EINVAL: invalid argument, rename '" + from + "' -> '" + to + "'"), { code: 'EINVAL', path: String(from), dest: String(to) });
    }
    return renameSync.call(fs, from, to);
  };
}
