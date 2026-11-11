'use strict';

// Entry point for Windows Task Scheduler: node app/cli.js run-job <jobId>
const jobs = require('./lib/jobs');

async function main() {
  const [command, id] = process.argv.slice(2);
  if (command !== 'run-job' || !id) {
    console.error('Usage: node app/cli.js run-job <jobId>');
    return 2;
  }
  let started;
  try {
    started = jobs.runNow(id);
  } catch (err) {
    // The job's spec does not validate any more (its server profile was deleted, say). The failure
    // goes into the history as a failed run, where someone looks; Task Scheduler gets exit code 2.
    const failed = jobs.recordFailure(id, err);
    console.error(`Job ${id} could not start: ${err.message}${failed ? ` (recorded as run ${failed.id})` : ''}`);
    return 2;
  }
  const { id: runId, done } = started;
  console.log(`Run ${runId} started for job ${id}`);
  const meta = await done;
  // A batch stays "done" when some of its databases could not be compared (the others have their
  // reports), but Task Scheduler must not show that as a successful task.
  const failed = meta.errors || 0;
  console.log(`Run ${runId} finished: ${meta.status}${failed ? `, ${failed} database(s) could not be compared` : ''}`);
  return meta.status === 'done' && !failed ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err.message);
  process.exit(2);
});
