// Database triggers that refuse DDL (RAISERROR and ROLLBACK in a trigger ON DATABASE). The
// scripts create, change and drop such triggers themselves, and an enabled one fires on every
// statement after it, also on the statements of the script that put it there:
// - a sync script that enabled the source's guard left a target on which its own rollback script
//   could drop nothing (every DROP ended with Msg 3609);
// - a trigger created enabled refused the CREATE of the next trigger in the same script;
// - CREATE OR ALTER of an enabled trigger that watches ALTER TRIGGER fired on itself;
// - a rollback script that enabled the target's own guard again right after putting its text
//   back had that guard refuse the drops that followed (trNoDrop: the index and the procedure the
//   sync script created stayed).
// So the scripts keep the database triggers they touch disabled until all of them are in place.
// A rollback starts by disabling them, and enables the ones that were enabled before the sync
// script with its last statements.
// - a sync script disabled them only in its last section. Run a second time, it met the guard
//   its first run had enabled: every statement was refused, and the statements that enable the
//   triggers again were never reached. And a guard of the target itself that the source has
//   disabled (trHold) refused the script from its first statement, on the first run.
//   (On SQL Server 2025 a refusal can be worse than Msg 3609: when the statement that is rolled
//   back is the ALTER of a disabled trigger that itself watches ALTER_TRIGGER, the server ends
//   with an access violation, Error 17310. trSelf is such a trigger. Nothing in this file may
//   let an enabled trigger refuse an ALTER TRIGGER: that takes the test server down.)
// So a sync script, too, disables with its first statements every database trigger it creates,
// changes or enables, and a rollback script also the ones it only enables at its end.
//
// The second test: the same on a target that was read without VIEW DEFINITION. A database
// trigger that is "only in source" may then be one the target has, hidden from the comparison.
// The scripts must keep the ones they create from refusing their own statements, and leave the
// hidden ones as they are: text, enabled or not, and in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildFixture, compare, counts } from './support/engine.js';
import { matchGolden, scrubFile } from './support/golden.js';
import { messageNumbers } from './support/incomplete.js';
import { DB_PREFIX, USER_OBJECT_COUNT, dropDatabase, query, recreateDatabase, runScriptFile, skipWithoutServer } from './support/sql.js';

const skip = skipWithoutServer();
const source = `${DB_PREFIX}ddlguard_src`;
const target = `${DB_PREFIX}ddlguard_tgt`;
const same = { onlyInSource: 0, onlyInTarget: 0, different: 0, unverified: 0 };

// The database triggers of a database: name, state, and whether one has the source's text (trSelf
// and trNoDrop have another text on each side).
function databaseTriggers(database: string): string[] {
  const run = query([
    "SELECT CONCAT(t.name, CASE WHEN t.is_disabled = 1 THEN ' DISABLED' ELSE ' ENABLED' END,",
    "CASE WHEN m.definition LIKE '%(source)%' THEN ' (text of the source)' ELSE '' END)",
    'FROM sys.triggers t JOIN sys.sql_modules m ON m.object_id = t.object_id WHERE t.parent_class = 0',
  ].join(' '), database);
  assert.ok(run.ok, run.output);
  return run.output.trim().split(/\r?\n/).sort();
}

// Statements a script printed for a person to run, run as a person would: pasted as they are
// into a new session, which is not in the database they are for (sqlcmd starts in the default
// database of the login). They name their database themselves.
function runAsPrinted(file: string, statements: string[], database: string): void {
  writeFileSync(file, `PRINT N'the session starts in ' + DB_NAME();\r\nGO\r\n${statements.map((s) => `${s}\r\nGO\r\n`).join('')}`, 'utf8');
  const run = runScriptFile(file);
  assert.ok(run.ok, run.output);
  const started = /^the session starts in (\w+)/m.exec(run.output)?.[1];
  assert.ok(started && started !== database, run.output);
  assert.doesNotMatch(run.output, /Msg \d+/, run.output);
}

// The index and the procedure that only the source has.
function added(database: string): string {
  const run = query("SELECT CONCAT('index:', (SELECT COUNT(*) FROM sys.indexes WHERE name = N'IX_Items_Name'), ' procedure:', (SELECT COUNT(*) FROM sys.procedures WHERE name = N'pItems'))", database);
  assert.ok(run.ok, run.output);
  return run.output.trim();
}

const SOURCE_TRIGGERS = ['trAaa ENABLED', 'trBlock ENABLED', 'trGuard ENABLED', 'trHold DISABLED', 'trNoDrop ENABLED (text of the source)', 'trSelf ENABLED (text of the source)', 'trZeta ENABLED'];
const TARGET_TRIGGERS = ['trGuard DISABLED', 'trHold ENABLED', 'trNoDrop ENABLED', 'trSelf ENABLED'];

test('engine: ddlguard (database triggers that refuse DDL do not stop the scripts that write them)', { skip }, async (t) => {
  buildFixture('ddlguard', source, target);
  assert.deepEqual(databaseTriggers(source), SOURCE_TRIGGERS, 'the fixture is not what this test expects');
  assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS, 'the fixture is not what this test expects');
  assert.equal(added(target), 'index:0 procedure:0');

  const before = compare({ dir: 'ddlguard', name: 'before', source, target });
  assert.equal(before.exitCode, 1, `expected differences (exit 1):\n${before.log}`);
  assert.equal(before.result['syncError'], '', 'sync script generation failed');
  assert.equal(before.result['rollbackError'], '', 'rollback script generation failed');
  const diffs = before.result['diffs'] as { Object: string; Status: string; Detail: string }[];
  // By name, the two that refuse statements stand between the two that do not.
  assert.deepEqual(diffs.filter((d) => d.Object.endsWith('(database trigger)')).map((d) => `${d.Object}: ${d.Status}`), [
    'trAaa (database trigger): OnlyInSource',
    'trBlock (database trigger): OnlyInSource',
    'trGuard (database trigger): Different',
    'trHold (database trigger): Different',
    'trNoDrop (database trigger): Different',
    'trSelf (database trigger): Different',
    'trZeta (database trigger): OnlyInSource',
  ]);
  assert.equal(diffs.find((d) => d.Object === 'trGuard (database trigger)')?.Detail, 'State: source ENABLED, target DISABLED');
  assert.equal(diffs.find((d) => d.Object === 'trHold (database trigger)')?.Detail, 'State: source DISABLED, target ENABLED');

  // What a second run of the sync script meets that is there already: the index (Msg 1913; a
  // procedure and a trigger are CREATE OR ALTER). Nothing else may be said, and no statement
  // may be refused by a trigger (Msg 3609, with the Msg 50000 of its RAISERROR).
  const ALREADY_THERE = ['1913'];

  await t.test('output matches the golden files', () => {
    matchGolden('ddlguard', 'sync.sql', scrubFile(before.files.sync));
    matchGolden('ddlguard', 'rollback.sql', scrubFile(before.files.rollback));
  });

  // As SSMS runs it: every batch, whatever failed before. Nothing may fail. (The target's own
  // trHold is enabled when the script starts, and refuses every DDL statement.)
  await t.test('the sync script runs without a single error', () => {
    const run = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.doesNotMatch(run.output, /Msg \d+/, run.output);
    assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS);
    assert.equal(added(target), 'index:1 procedure:1');
  });

  await t.test('nothing is left to compare after sync', () => {
    const after = compare({ dir: 'ddlguard', name: 'after-sync', source, target });
    assert.deepEqual(counts(after), same, after.log);
  });

  // The target now has every guard of the source, enabled: trGuard refuses all DDL, trBlock the
  // CREATE of a trigger, trSelf its ALTER. The script disables them again before anything else.
  await t.test('the sync script can be run again, and ends as one run of it does', () => {
    const run = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.deepEqual(messageNumbers(run.output), ALREADY_THERE, run.output);
    assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS);
    assert.equal(added(target), 'index:1 procedure:1');
    const after = compare({ dir: 'ddlguard', name: 'after-second-sync', source, target });
    assert.deepEqual(counts(after), same, after.log);
  });

  // A second run with stop-on-error (sqlcmd -b) ends at the first thing that is there already,
  // the index: after the first section, so with every trigger the script manages disabled. It
  // did so without a word. Now each trigger that is disabled says how to enable it again, and
  // the header says not to run the script that way.
  await t.test('a sync script that stops after its first section has printed how to enable each trigger again', () => {
    assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS);
    const use = (name: string): string => `USE [${target}]; ENABLE TRIGGER [${name}] ON DATABASE;`;
    const stoppedRun = (): string[] => {
      const stopped = runScriptFile(before.files.sync);
      assert.equal(stopped.ok, false, stopped.output);
      assert.deepEqual(messageNumbers(stopped.output), ALREADY_THERE, stopped.output);
      assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS.map((line) => line.replace(' ENABLED', ' DISABLED')));
      // One line for each trigger it disabled, with the database in front and in the statement.
      const lines = printedLines(stopped.output);
      for (const line of lines) assert.ok(line.startsWith(`database-diff: [${target}]: database trigger [`), line);
      assert.deepEqual(printedEnables(stopped.output).length, lines.length, stopped.output);
      return printedEnables(stopped.output);
    };
    // The six the last section would have enabled, in the order they were disabled: the new
    // ones (there since the first run), then the changed ones. Not trHold: it was disabled.
    const recovery = stoppedRun();
    assert.deepEqual(recovery, ['trAaa', 'trBlock', 'trZeta', 'trGuard', 'trNoDrop', 'trSelf'].map(use));
    // Those statements, as printed, in a new session: every trigger is as it was before the run.
    runAsPrinted(path.join(path.dirname(before.files.sync), 'sync.recovery.sql'), recovery, target);
    assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS);
    // Or the script once more, run so that it reaches its end.
    assert.deepEqual(stoppedRun(), recovery);
    const again = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.deepEqual(messageNumbers(again.output), ALREADY_THERE, again.output);
    assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS);
    // That run found them disabled already: it has nothing to say.
    assert.deepEqual(printedLines(again.output), [], again.output);
    const after = compare({ dir: 'ddlguard', name: 'after-stopped-sync', source, target });
    assert.deepEqual(counts(after), same, after.log);
  });

  // The target now has the source's guard, enabled: it refuses every DROP the rollback has to make.
  // And its own trNoDrop, which was enabled before the sync script and is again after the
  // rollback: only after the index and the procedure are dropped, which it would refuse.
  await t.test('the rollback script runs at the first go and puts the target back as it was', () => {
    const run = runScriptFile(before.files.rollback);
    assert.ok(run.ok, run.output);
    assert.doesNotMatch(run.output, /Msg \d+/, run.output);
    assert.equal(added(target), 'index:0 procedure:0');
    assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS);
    const after = compare({ dir: 'ddlguard', name: 'after-rollback', sourceSnapshot: before.files.targetSnapshot, target });
    assert.deepEqual(counts(after), same, after.log);
  });

  // The first run enabled trHold again, which refuses all DDL: the second disables it first.
  await t.test('a second run of the rollback script changes nothing', () => {
    const run = runScriptFile(before.files.rollback);
    assert.ok(run.ok, run.output);
    assert.doesNotMatch(run.output, /Msg \d+/, run.output);
    assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS);
    assert.equal(added(target), 'index:0 procedure:0');
    const after = compare({ dir: 'ddlguard', name: 'after-second-rollback', sourceSnapshot: before.files.targetSnapshot, target });
    assert.deepEqual(counts(after), same, after.log);
  });

  // A script that stops before its last statements (a person stops it, the connection goes)
  // leaves the triggers it manages disabled. It knows all of them (the comparison read the
  // target in full), so running it again, in any session, finishes the job.
  const stoppedBefore = (file: string, lastPart: string): string => {
    const text = readFileSync(file, 'utf8');
    const cut = text.indexOf(lastPart);
    assert.ok(cut > 0, `${path.basename(file)} has "${lastPart}"`);
    const copy = file.replace(/\.sql$/, '.stopped.sql');
    writeFileSync(copy, text.slice(0, cut), 'utf8');
    return copy;
  };

  await t.test('a sync script that stopped part way is finished by running it again', () => {
    buildFixture('ddlguard', source, target);
    // A first run that gets no further than its first section (an error in the section after
    // it, under stop-on-error, does that). The target's own triggers that were enabled are
    // disabled, and each has its line: the two the script would enable again at its end, and
    // trHold, which the source has disabled and the script would leave so.
    const early = runScriptFile(stoppedBefore(before.files.sync, '-- Indexes, primary keys and unique constraints'));
    assert.ok(early.ok, early.output);
    assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS.map((line) => line.replace(' ENABLED', ' DISABLED')));
    const said = printedLines(early.output);
    assert.deepEqual(said.map((line) => /database trigger \[(\w+)\] is disabled(, as the source has it, and stays so| until the last statements of this script enable it again)/.exec(line)?.slice(1, 3).join('')), [
      'trHold, as the source has it, and stays so',
      'trNoDrop until the last statements of this script enable it again',
      'trSelf until the last statements of this script enable it again',
    ], early.output);
    // Run as printed, they put the target back as it was before the script touched it.
    runAsPrinted(path.join(path.dirname(before.files.sync), 'sync.early.recovery.sql'), printedEnables(early.output), target);
    assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS);

    const stopped = runScriptFile(stoppedBefore(before.files.sync, '-- Enabled now that all of them are in place'), undefined, { continueOnError: true });
    assert.doesNotMatch(stopped.output, /Msg \d+/, stopped.output);
    // The three it created say so too, as each is disabled after its CREATE.
    assert.deepEqual(printedLines(stopped.output).map((line) => /database trigger \[(\w+)\] is (created|disabled)/.exec(line)?.slice(1, 3).join(' ')), [
      'trHold disabled', 'trNoDrop disabled', 'trSelf disabled', 'trAaa created', 'trBlock created', 'trZeta created',
    ], stopped.output);
    // Everything is created and changed, and every trigger the script manages is disabled.
    assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS.map((line) => line.replace(' ENABLED', ' DISABLED')));
    const again = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.deepEqual(messageNumbers(again.output), ALREADY_THERE, again.output);
    assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS);
    const after = compare({ dir: 'ddlguard', name: 'after-resumed-sync', source, target });
    assert.deepEqual(counts(after), same, after.log);
  });

  await t.test('a rollback script that stopped part way is finished by running it again', () => {
    assert.deepEqual(databaseTriggers(target), SOURCE_TRIGGERS);
    const stopped = runScriptFile(stoppedBefore(before.files.rollback, '-- Last, when nothing is left for them to refuse'));
    assert.ok(stopped.ok, stopped.output);
    // What the sync script created is gone, the rest has its text back, and all are disabled.
    assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS.map((line) => line.replace(' ENABLED', ' DISABLED')));
    const again = runScriptFile(before.files.rollback);
    assert.ok(again.ok, again.output);
    assert.doesNotMatch(again.output, /Msg \d+/, again.output);
    assert.deepEqual(databaseTriggers(target), TARGET_TRIGGERS);
    const after = compare({ dir: 'ddlguard', name: 'after-resumed-rollback', sourceSnapshot: before.files.targetSnapshot, target });
    assert.deepEqual(counts(after), same, after.log);
  });
});

// ---------------------------------------------------------------------------------------------
// The target read without VIEW DEFINITION (test/fixtures/ddlguard-incomplete).
// ---------------------------------------------------------------------------------------------

const incompleteSource = `${DB_PREFIX}ddlguard_inc_src`;
const incompleteTarget = `${DB_PREFIX}ddlguard_inc_tgt`;

interface Snapshot {
  canViewDefinition: boolean;
  categories: Record<string, Record<string, unknown>>;
}

// trHiddenOff and trHiddenOn are in the target before any script runs, with their own text and
// the other state than the source has: whatever a script does, these two lines stay.
const HIDDEN = ['trHiddenOff DISABLED', 'trHiddenOn ENABLED'];
const INCOMPLETE_SOURCE = ['trAaa ENABLED', 'trBlock ENABLED', 'trHiddenOff ENABLED (text of the source)', 'trHiddenOn DISABLED (text of the source)', 'trNewOff DISABLED', 'trOld ENABLED (text of the source)', 'trZeta ENABLED'];
const INCOMPLETE_TARGET = [...HIDDEN, 'trOld ENABLED'];
// After the sync script: what it created as the source has it, trOld with the source's text.
const INCOMPLETE_SYNCED = ['trAaa ENABLED', 'trBlock ENABLED', ...HIDDEN, 'trNewOff DISABLED', 'trOld ENABLED (text of the source)', 'trZeta ENABLED'];
// After the rollback script as it is written: the drops of what the sync script created are
// comments (one of them may have been there before), so those stay, as the sync script left them.
const INCOMPLETE_ROLLED_BACK = ['trAaa ENABLED', 'trBlock ENABLED', ...HIDDEN, 'trNewOff DISABLED', 'trOld ENABLED', 'trZeta ENABLED'];

// What a script prints for a person to run when it stops before its last statements: the
// statement that enables a trigger it disabled, after "run: ". It names its database (USE): a
// script of several databases prints one for each, and a new query window is in none of them.
function printedEnables(output: string): string[] {
  return [...output.matchAll(/run: (USE \[(?:[^\]]|\]\])+\]; ENABLE TRIGGER \[(?:[^\]]|\]\])+\] ON DATABASE;)/g)].map((m) => m[1] ?? '');
}

// Every line a script prints about its triggers says which database it is about.
const ABOUT = `database-diff: [${incompleteTarget}]: `;
function printedLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.startsWith('database-diff: '));
}

// The lines a script prints about a trigger it finds disabled without having disabled it itself.
function printedWarnings(output: string): string[] {
  return printedLines(output).filter((line) => line.startsWith(`${ABOUT}WARNING: `));
}

const enable = (name: string): string => `USE [${incompleteTarget}]; ENABLE TRIGGER [${name}] ON DATABASE;`;
// A warning says the same of every trigger: with the names taken out, one text is left.
const wordings = (warnings: string[]): string[] => [...new Set(warnings.map((line) => line.replace(/\[tr\w+\]/g, '[x]')))];

test('engine: ddlguard on a target read without VIEW DEFINITION (the scripts keep their own triggers quiet and leave hidden ones alone)', { skip }, async (t) => {
  buildFixture('ddlguard-incomplete', incompleteSource, incompleteTarget);
  assert.deepEqual(databaseTriggers(incompleteSource), INCOMPLETE_SOURCE, 'the fixture is not what this test expects');
  assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_TARGET, 'the fixture is not what this test expects');
  assert.equal(added(incompleteTarget), 'index:0 procedure:0');

  // The target as a login without VIEW DEFINITION reads it: flagged, and without two database
  // triggers that are really there.
  const live = compare({ dir: 'ddlguard-incomplete', name: 'live', source: incompleteSource, target: incompleteTarget });
  const snapshot = JSON.parse(readFileSync(live.files.targetSnapshot, 'utf8')) as Snapshot;
  for (const name of ['trHiddenOff', 'trHiddenOn']) {
    const key = `(database trigger)|${name}`;
    assert.ok(snapshot.categories['Trigger']?.[key], `the target snapshot has ${name}`);
    delete snapshot.categories['Trigger']?.[key];
  }
  snapshot.canViewDefinition = false;
  const hidden = path.join(path.dirname(live.files.targetSnapshot), 'hidden.target.snapshot.json');
  writeFileSync(hidden, JSON.stringify(snapshot), 'utf8');

  const before = compare({ dir: 'ddlguard-incomplete', name: 'before', source: incompleteSource, targetSnapshot: hidden });
  assert.equal(before.result['syncError'], '', 'sync script generation failed');
  assert.equal(before.result['rollbackError'], '', 'rollback script generation failed');
  const diffs = before.result['diffs'] as { Object: string; Status: string }[];
  assert.deepEqual(diffs.filter((d) => d.Object.endsWith('(database trigger)')).map((d) => `${d.Object}: ${d.Status}`), [
    'trAaa (database trigger): OnlyInSource',
    'trBlock (database trigger): OnlyInSource',
    'trHiddenOff (database trigger): OnlyInSource',
    'trHiddenOn (database trigger): OnlyInSource',
    'trNewOff (database trigger): OnlyInSource',
    'trOld (database trigger): Different',
    'trZeta (database trigger): OnlyInSource',
  ]);

  // The rollback script with the drops of what the sync script created uncommented.
  const uncommented = path.join(path.dirname(before.files.rollback), 'uncommented.rollback.sql');
  // Both databases as the fixture makes them, for the tests that start from the top again: they
  // must not depend on what the tests before them left. (The scripts of the comparison above
  // stay right: the fixture makes the same databases every time.)
  const backToStart = (): void => {
    buildFixture('ddlguard-incomplete', incompleteSource, incompleteTarget);
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_TARGET);
    assert.equal(added(incompleteTarget), 'index:0 procedure:0');
  };
  const runPrinted = (name: string, statements: string[]): void => runAsPrinted(path.join(path.dirname(before.files.rollback), name), statements, incompleteTarget);

  await t.test('output matches the golden files', () => {
    matchGolden('ddlguard-incomplete', 'sync.sql', scrubFile(before.files.sync));
    matchGolden('ddlguard-incomplete', 'rollback.sql', scrubFile(before.files.rollback));
  });

  // The scripts keep notes in a temporary table. When the database check at their top fails,
  // NOEXEC is on for every batch after it: the table is never created, and the batches that
  // name it must still pass (they are compiled, not run). Nothing but the USE that failed
  // (Msg 911) and the message of the check (Msg 50000) may show.
  await t.test('a script whose database cannot be used changes nothing, and its notes are not in the way', () => {
    const other = `${incompleteTarget}_other`;
    const gone = `${incompleteTarget}_gone`;
    recreateDatabase(other);
    dropDatabase(gone);
    for (const script of [before.files.sync, before.files.rollback]) {
      const name = path.basename(script);
      const copy = script.replace(/\.sql$/, '.wrong-database.sql');
      writeFileSync(copy, readFileSync(script, 'utf8').split(incompleteTarget).join(gone), 'utf8');
      const run = runScriptFile(copy, other, { continueOnError: true });
      assert.deepEqual(messageNumbers(run.output), ['911', '50000'], `${name}:\n${run.output}`);
      assert.match(run.output, /cannot use database/, `${name}:\n${run.output}`);
      assert.equal(query(USER_OBJECT_COUNT, other).output.trim(), '0', `${name} ran in another database:\n${run.output}`);
    }
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_TARGET);
  });

  // As SSMS runs it: every batch. trBlock is created enabled and refuses the CREATE, ALTER and
  // DROP of a trigger: not one statement of the script may end with its Msg 3609. The only
  // errors are the two triggers that are there already (Msg 2714), which stay as they are.
  await t.test('the sync script is not refused by a trigger it created, and leaves the hidden ones as they are', () => {
    const run = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.deepEqual(messageNumbers(run.output), ['2714', '2714'], run.output);
    for (const name of ['trHiddenOff', 'trHiddenOn']) {
      assert.ok(run.output.includes(`There is already an object named '${name}' in the database.`), `${name}:\n${run.output}`);
    }
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_SYNCED);
    assert.equal(added(incompleteTarget), 'index:1 procedure:1');
  });

  // The target now has trBlock, enabled: it refuses the ALTER that puts trOld back and the drop
  // of the index. The rollback script cannot know that the sync script created it, so it does
  // not drop it: it keeps it disabled while it runs, and enables it again at its end.
  await t.test('the rollback script runs at the first go, and what it cannot tell apart ends as it started', () => {
    const run = runScriptFile(before.files.rollback);
    assert.ok(run.ok, run.output);
    assert.doesNotMatch(run.output, /Msg \d+/, run.output);
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_ROLLED_BACK);
    // The index went (an active drop). The procedure stays: on such a target the drop of a
    // module is a comment.
    assert.equal(added(incompleteTarget), 'index:0 procedure:1');
  });

  // A person uncomments the drops of what the sync script really created, and runs the file
  // again. trBlock refuses DROP TRIGGER, its own included: it is dropped while it is disabled.
  await t.test('the drops of the triggers the sync script created run once they are uncommented', () => {
    const created = ['DROP TRIGGER IF EXISTS [trAaa] ON DATABASE;', 'DROP TRIGGER IF EXISTS [trBlock] ON DATABASE;', 'DROP TRIGGER IF EXISTS [trNewOff] ON DATABASE;', 'DROP TRIGGER IF EXISTS [trZeta] ON DATABASE;', 'DROP PROCEDURE IF EXISTS [dbo].[pItems];'];
    let script = readFileSync(before.files.rollback, 'utf8');
    for (const drop of created) {
      assert.ok(script.includes(`\r\n-- ${drop}\r\n`), `the rollback script has "-- ${drop}"`);
      script = script.replace(`\r\n-- ${drop}\r\n`, () => `\r\n${drop}\r\nGO\r\n`);
    }
    for (const name of ['trHiddenOff', 'trHiddenOn']) assert.ok(script.includes(`\r\n-- DROP TRIGGER IF EXISTS [${name}] ON DATABASE;\r\n`), name);
    const file = uncommented;
    writeFileSync(file, script, 'utf8');
    const run = runScriptFile(file);
    assert.ok(run.ok, run.output);
    assert.doesNotMatch(run.output, /Msg \d+/, run.output);
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_TARGET);
    assert.equal(added(incompleteTarget), 'index:0 procedure:0');
    // Read in full: the target is what it was before the sync script.
    const after = compare({ dir: 'ddlguard-incomplete', name: 'after-rollback', sourceSnapshot: live.files.targetSnapshot, target: incompleteTarget });
    assert.deepEqual(counts(after), same, after.log);
  });

  // The notes of a script are in a temporary table of its session. A script that stopped before
  // its last statements left the triggers it created (sync) or found enabled (rollback)
  // disabled; its header says to run it again in the same session. Here: the script up to those
  // last statements, then the whole script, as one file, which sqlcmd runs in one session.
  await t.test('a script that stopped part way finishes the job when it is run again in the same session', () => {
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_TARGET);
    const resumed = (file: string, lastPart: string): string => {
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const cut = text.indexOf(lastPart);
      assert.ok(cut > 0, `${path.basename(file)} has "${lastPart}"`);
      const copy = file.replace(/\.sql$/, '.resumed.sql');
      // The part that ran before it stopped ends with its own batch; the second run follows.
      writeFileSync(copy, `\uFEFF${text.slice(0, cut)}\r\nGO\r\n${text}`, 'utf8');
      return copy;
    };
    // The sync script: the second run meets what the first created (Msg 2714, and Msg 1913
    // for the index), and enables the triggers the first run noted as its own.
    const sync = runScriptFile(resumed(before.files.sync, '-- Enabled now that all of them are in place'), undefined, { continueOnError: true });
    const numbers = messageNumbers(sync.output);
    assert.deepEqual([...new Set(numbers)].sort(), ['1913', '2714'], sync.output);
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_SYNCED);
    // The rollback script: the second run finds them disabled already, and still enables the
    // ones the first run noted.
    const rollback = runScriptFile(resumed(before.files.rollback, '-- Last, when nothing is left for them to refuse'), undefined, { continueOnError: true });
    assert.doesNotMatch(rollback.output, /Msg \d+/, rollback.output);
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_ROLLED_BACK);
  });

  // The same rollback script, stopped before its last statements, and then run again in ANOTHER
  // session: that run has no notes of the first. It finds the triggers disabled, so it disables
  // and notes nothing, and its last statements enable only what is noted. It used to end without
  // a word, with trHiddenOn (the target's own, enabled before the sync script and never touched
  // by it) disabled for good, and trAaa, trBlock and trZeta with it. Now the run that disables a
  // trigger prints the statement that enables it again, and a later run warns about every
  // trigger it finds disabled.
  await t.test('a rollback that stopped part way says which triggers to enable, and a run in another session warns', () => {
    backToStart();
    const synced = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.deepEqual(messageNumbers(synced.output), ['2714', '2714'], synced.output);
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_SYNCED);

    const text = readFileSync(before.files.rollback, 'utf8');
    const cut = text.indexOf('-- Last, when nothing is left for them to refuse');
    assert.ok(cut > 0);
    const stoppedFile = before.files.rollback.replace(/\.sql$/, '.stopped.sql');
    writeFileSync(stoppedFile, text.slice(0, cut), 'utf8');
    const stopped = runScriptFile(stoppedFile);
    assert.ok(stopped.ok, stopped.output);
    // What it disabled: the four that were enabled, the target's own trHiddenOn among them. For
    // each, the statement to run.
    const recovery = printedEnables(stopped.output);
    assert.deepEqual(recovery, [enable('trAaa'), enable('trBlock'), enable('trHiddenOn'), enable('trZeta')], stopped.output);
    const allDisabled = ['trAaa DISABLED', 'trBlock DISABLED', 'trHiddenOff DISABLED', 'trHiddenOn DISABLED', 'trNewOff DISABLED', 'trOld DISABLED', 'trZeta DISABLED'];
    assert.deepEqual(databaseTriggers(incompleteTarget), allDisabled);

    // Another session: sqlcmd again. It ends well, and enables only trOld, which the comparison
    // saw (its state before the sync script is in the script itself).
    const again = runScriptFile(before.files.rollback);
    assert.ok(again.ok, again.output);
    assert.doesNotMatch(again.output, /Msg \d+/, again.output);
    assert.deepEqual(databaseTriggers(incompleteTarget), allDisabled.map((line) => (line === 'trOld DISABLED' ? 'trOld ENABLED' : line)));
    // But not without a word: a warning for every trigger it could not tell from the sync
    // script's own and found disabled, each with the statement that enables it.
    const warnings = printedWarnings(again.output);
    const disabled = ['trAaa', 'trBlock', 'trHiddenOff', 'trHiddenOn', 'trNewOff', 'trZeta'];
    assert.deepEqual(warnings.map((line) => /WARNING: database trigger \[(\w+)\] is disabled, and this run did not disable it\./.exec(line)?.[1]), disabled, again.output);
    assert.deepEqual(printedEnables(warnings.join('\n')), disabled.map(enable));
    // One wording for all six, and no cause in it. This run cannot know why a trigger is
    // disabled: trHiddenOff is the target's own and was disabled before anything ran, trNewOff
    // the sync script created disabled, and the other four the stopped run disabled. (It used to
    // say of trHiddenOff "that run disabled it", which was not so, and to play down trHiddenOn,
    // the one that most needs enabling, because the source has a trigger of that name disabled.)
    // What to enable is what the stopped run listed: the warning sends the reader there.
    assert.deepEqual(wordings(warnings), [
      `${ABOUT}WARNING: database trigger [x] is disabled, and this run did not disable it. It may have been disabled all along. If an earlier run of this script stopped part way, the lines that run printed list what it disabled: only if this trigger is among them, run: USE [${incompleteTarget}]; ENABLE TRIGGER [x] ON DATABASE;`,
    ]);
    // A run that disables nothing prints no line of the first kind, and every line it prints
    // names the database.
    assert.deepEqual(printedLines(again.output), warnings, again.output);
    assert.equal(printedLines(stopped.output).length, recovery.length, stopped.output);
    for (const line of printedLines(stopped.output)) assert.ok(line.startsWith(`${ABOUT}database trigger [`), line);

    // Following what the stopped run printed puts every trigger back as the rollback leaves it.
    runPrinted('rollback.recovery.sql', recovery);
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_ROLLED_BACK);
  });

  // The sync script, run the way that stops at the first error (sqlcmd -b). On such a target an
  // error is expected: the CREATE of a trigger that is there already (Msg 2714). The script
  // stops there, with the triggers it created before that still disabled, and trOld, which it
  // was about to change. Its header says not to run it that way; when it happens, the run has
  // printed what to enable, and the script run again to its end warns about the same triggers.
  await t.test('a sync script run with stop-on-error says which of the triggers it created to enable', () => {
    backToStart();
    const stopped = runScriptFile(before.files.sync);
    assert.equal(stopped.ok, false, stopped.output);
    assert.deepEqual(messageNumbers(stopped.output), ['2714'], stopped.output);
    assert.ok(stopped.output.includes("There is already an object named 'trHiddenOff' in the database."), stopped.output);
    // trOld as well: the script disabled it with its first statements, to change it.
    assert.deepEqual(printedEnables(stopped.output), [enable('trOld'), enable('trAaa'), enable('trBlock')], stopped.output);
    // What the header says to run after the script has been run again to its end: the
    // statements of the triggers this run created. (trOld is enabled by that run itself.)
    const recovery = printedEnables(printedLines(stopped.output).filter((line) => / is created, and disabled until /.test(line)).join('\n'));
    assert.deepEqual(recovery, [enable('trAaa'), enable('trBlock')], stopped.output);
    assert.deepEqual(databaseTriggers(incompleteTarget), ['trAaa DISABLED', 'trBlock DISABLED', ...HIDDEN, 'trOld DISABLED']);

    // As the header says: again to its end, every batch, in another session. The triggers the
    // first run created are "there already" now: not touched, and a warning for each that is
    // disabled where the source has it enabled (trHiddenOff too, which always was).
    const again = runScriptFile(before.files.sync, undefined, { continueOnError: true });
    assert.deepEqual([...new Set(messageNumbers(again.output))].sort(), ['1913', '2714'], again.output);
    const warnings = printedWarnings(again.output);
    assert.deepEqual(warnings.map((line) => /WARNING: database trigger \[(\w+)\] is disabled, and this run did not create it: it was there before this run\./.exec(line)?.[1]), ['trAaa', 'trBlock', 'trHiddenOff'], again.output);
    assert.deepEqual(printedEnables(warnings.join('\n')), ['trAaa', 'trBlock', 'trHiddenOff'].map(enable));
    // The same wording for the two the stopped run created and for trHiddenOff, which is the
    // target's own: what to enable is what the stopped run listed.
    assert.deepEqual(wordings(warnings), [
      `${ABOUT}WARNING: database trigger [x] is disabled, and this run did not create it: it was there before this run. It may have been disabled all along. If an earlier run of this script stopped part way, the lines that run printed list what it created: only if this trigger is among them, run: USE [${incompleteTarget}]; ENABLE TRIGGER [x] ON DATABASE;`,
    ]);
    for (const line of [...printedLines(stopped.output), ...printedLines(again.output)]) assert.ok(line.startsWith(ABOUT), line);
    assert.deepEqual(databaseTriggers(incompleteTarget), ['trAaa DISABLED', 'trBlock DISABLED', ...HIDDEN, 'trNewOff DISABLED', 'trOld ENABLED (text of the source)', 'trZeta ENABLED']);

    // Then the statements the stopped run printed for what it created: the target is as a sync
    // script that ran to its end leaves it.
    runPrinted('sync.recovery.sql', recovery);
    assert.deepEqual(databaseTriggers(incompleteTarget), INCOMPLETE_SYNCED);
    assert.equal(added(incompleteTarget), 'index:1 procedure:1');

    // And the header of the script says not to run it that way.
    const header = readFileSync(before.files.sync, 'utf8').split('\r\nUSE [')[0]?.replace(/\r\n--\s*/g, ' ') ?? '';
    assert.match(header, /Msg 2714 is therefore expected on this target\. Do not run this script with stop-on-error \(sqlcmd -b\)/);
    assert.match(header, /run it again to its end, then run those statements for the triggers it created/);
  });
});
