'use strict';

// Entry point for Windows Task Scheduler: node app/cli.js run-job <jobId>
const jobs = require('./lib/jobs');

async function main() {
  const [command, id] = process.argv.slice(2);
  if (command !== 'run-job' || !id) {
    console.error('Usage: node app/cli.js run-job <jobId>');
    return 2;
  }
  const { id: runId, done } = jobs.runNow(id);
  console.log(`Run ${runId} started for job ${id}`);
  const meta = await done;
  console.log(`Run ${runId} finished: ${meta.status}`);
  return meta.status === 'done' ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err.message);
  process.exit(2);
});
