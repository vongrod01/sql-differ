// What the sync and rollback scripts say for differences that the fixture databases cannot show
// (see test/support/snapshot.ts). No database: both sides are hand-made snapshot files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comments, scriptsFor, snapshot, statements } from './support/snapshot.js';

// ---------------------------------------------------------------------------------------------
// Columns of a user-defined (alias) type. COLLATE cannot be written for one (Msg 452): the column
// has the collation of its database.
// ---------------------------------------------------------------------------------------------

test('script: a column of a user-defined type is never written with COLLATE', () => {
  const side = (collation: string, nullable: string) => snapshot()
    .database(collation)
    .aliasType('tCode', 'varchar(20) NULL')
    .table('T')
    .column('T', 'Id', { Nullable: 'NOT NULL' })
    .column('T', 'Code', { Type: 'dbo.tCode', Collation: collation })
    .column('T', 'Other', { Type: 'dbo.tCode', Collation: collation, Nullable: nullable })
    .column('T', 'Plain', { Type: 'varchar(20)', Collation: collation });
  const source = side('Thai_CI_AS', 'NOT NULL').column('T', 'Added', { Type: 'dbo.tCode', Collation: 'Thai_CI_AS' });
  const target = side('SQL_Latin1_General_CP1_CI_AS', 'NULL');
  const s = scriptsFor('alias-collation', source, target);

  assert.equal(s.details['dbo.T.Code'], 'Collation: source Thai_CI_AS, target SQL_Latin1_General_CP1_CI_AS');
  assert.deepEqual(statements(s.sync), [
    // A new column: its collation differs from the target database's, and still no COLLATE.
    'ALTER TABLE [dbo].[T] ADD [Added] [dbo].[tCode] NULL;',
    // Nothing for Code: only its collation differs.
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Other] [dbo].[tCode] NOT NULL;',
    // A built-in type still gets its collation.
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Plain] varchar(20) COLLATE Thai_CI_AS NULL;',
  ]);
  const notScripted = comments(s.sync).filter((l) => /user-defined type/.test(l));
  assert.equal(notScripted.length, 2, s.sync);
  for (const line of notScripted) assert.match(line, /^-- Not scripted: .*COLLATE/);

  assert.deepEqual(statements(s.rollback), [
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Other] [dbo].[tCode] NULL;',
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Plain] varchar(20) COLLATE SQL_Latin1_General_CP1_CI_AS NULL;',
  ]);

  // With -IgnoreCollation an altered column keeps the collation the target has, which for a
  // user-defined type is not written either.
  const ignoring = scriptsFor('alias-collation-ignored', source, target, { options: ['-IgnoreCollation'] });
  assert.deepEqual(statements(ignoring.sync), [
    'ALTER TABLE [dbo].[T] ADD [Added] [dbo].[tCode] NULL;',
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Other] [dbo].[tCode] NOT NULL;',
  ]);
  assert.deepEqual(statements(ignoring.rollback), ['ALTER TABLE [dbo].[T] ALTER COLUMN [Other] [dbo].[tCode] NULL;']);
});

// ---------------------------------------------------------------------------------------------
// Computed columns. ALTER COLUMN cannot change one (Msg 4928), except ADD / DROP PERSISTED.
// ---------------------------------------------------------------------------------------------

test('script: a computed column is never altered', () => {
  const computed = { Computed: '([Qty]*(2))', Persisted: 'PERSISTED' };
  const source = snapshot().database('Thai_CI_AS').table('T')
    .column('T', 'Qty', { Type: 'bigint', Nullable: 'NOT NULL' })
    // Declared PERSISTED NOT NULL here, PERSISTED there.
    .column('T', 'Twice', { ...computed, Type: 'bigint', Nullable: 'NOT NULL' })
    // The type follows the column it is computed from.
    .column('T', 'Half', { Computed: '([Qty]/(2))', Type: 'bigint' })
    // Persisted here and NOT NULL, neither there.
    .column('T', 'Both', { ...computed, Nullable: 'NOT NULL' });
  const target = snapshot().database('Thai_CI_AS').table('T')
    .column('T', 'Qty', { Type: 'int', Nullable: 'NOT NULL' })
    .column('T', 'Twice', { ...computed, Type: 'bigint' })
    .column('T', 'Half', { Computed: '([Qty]/(2))', Type: 'int' })
    .column('T', 'Both', { Computed: '([Qty]*(2))' });
  const s = scriptsFor('computed-columns', source, target);

  // Nothing for Qty: three computed columns use it, so its ALTER COLUMN would fail (Msg 5074).
  assert.deepEqual(statements(s.sync), ['ALTER TABLE [dbo].[T] ALTER COLUMN [Both] ADD PERSISTED;']);
  // It is there to run by hand, between the drops of those columns and the statements that add
  // them again as the source has them.
  const byHand = comments(s.sync);
  const start = byHand.findIndex((l) => l.startsWith('-- Not run: computed columns [Twice], [Half], [Both] use this column'));
  assert.ok(start >= 0, s.sync);
  assert.match(byHand[start] ?? '', /Msg 5074, Msg 4922.*first drop the indexes, constraints and statistics/);
  assert.deepEqual(byHand.slice(start + 1, start + 10), [
    '-- BEGIN TRANSACTION;',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Twice];',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Half];',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Both];',
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [Qty] bigint NOT NULL;',
    '-- ALTER TABLE [dbo].[T] ADD [Twice] AS ([Qty]*(2)) PERSISTED NOT NULL;',
    '-- ALTER TABLE [dbo].[T] ADD [Half] AS ([Qty]/(2));',
    '-- ALTER TABLE [dbo].[T] ADD [Both] AS ([Qty]*(2)) PERSISTED NOT NULL;',
    '-- COMMIT TRANSACTION;',
  ]);
  // What to run by hand for NOT NULL, as comments.
  for (const line of [
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Twice];',
    '-- ALTER TABLE [dbo].[T] ADD [Twice] AS ([Qty]*(2)) PERSISTED NOT NULL;',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Both];',
    '-- ALTER TABLE [dbo].[T] ADD [Both] AS ([Qty]*(2)) PERSISTED NOT NULL;',
  ]) assert.ok(comments(s.sync).includes(line), `${line} expected in:\n${s.sync}`);
  // The type of Half is not something to change on its own: it changes with Qty. Its only drop
  // is the one in the group for Qty (below).
  assert.equal(s.sync.split('DROP COLUMN [Half]').length - 1, 1, s.sync);
  assert.equal(comments(s.sync).filter((l) => /^-- Not scripted: .*computed column/.test(l)).length, 3, s.sync);

  // The same the other way round: the columns come back as the target had them.
  assert.deepEqual(statements(s.rollback), ['ALTER TABLE [dbo].[T] ALTER COLUMN [Both] DROP PERSISTED;']);
  assert.ok(comments(s.rollback).includes('-- ALTER TABLE [dbo].[T] ADD [Twice] AS ([Qty]*(2)) PERSISTED;'), s.rollback);
  const back = comments(s.rollback);
  const backStart = back.findIndex((l) => l.startsWith('-- Not run: computed columns [Twice], [Half], [Both] use this column'));
  assert.deepEqual(back.slice(backStart + 1, backStart + 10), [
    '-- BEGIN TRANSACTION;',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Twice];',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Half];',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Both];',
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [Qty] int NOT NULL;',
    '-- ALTER TABLE [dbo].[T] ADD [Twice] AS ([Qty]*(2)) PERSISTED;',
    '-- ALTER TABLE [dbo].[T] ADD [Half] AS ([Qty]/(2));',
    '-- ALTER TABLE [dbo].[T] ADD [Both] AS ([Qty]*(2));',
    '-- COMMIT TRANSACTION;',
  ]);
});

// The lines after a "-- Not run: ... computed column" comment, up to the end of its batch.
function byHandLines(script: string, column: string): string[] {
  const lines = script.split('\n').map((l) => l.trimEnd());
  const header = lines.findIndex((l) => l.startsWith(`-- dbo.T.${column}: `));
  const start = lines.findIndex((l, i) => i > header && /^-- Not run: computed column/.test(l));
  const end = lines.indexOf('GO', header);
  return header >= 0 && start >= 0 && start < end ? lines.slice(start + 1, end) : [];
}

test('script: a column that a computed column uses is changed by hand, with those columns dropped and added again', () => {
  const HIDDEN = '(not readable)';
  const source = snapshot().database('Thai_CI_AS').table('T')
    // A new column that is not computed: first, as before.
    .column('T', 'Added', {})
    .column('T', 'Base', { Type: 'bigint', Nullable: 'NOT NULL' })
    // New, and computed from a column that changes: after that column's ALTER COLUMN.
    .column('T', 'BaseNew', { Computed: '([Base]+(1))' })
    // A default as well: its drop and add are inside the same group.
    .column('T', 'Dflt', { Type: 'bigint', Default: '((1))' }, { DefaultName: 'DF_T_Dflt' })
    .column('T', 'DfltTwice', { Computed: '([Dflt]*(2))', Persisted: 'PERSISTED', Type: 'bigint' })
    // The source's default cannot be read: still comments only, with the computed column around them.
    .column('T', 'Hid', { Type: 'bigint', Default: HIDDEN })
    .column('T', 'HidPlus', { Computed: '([Hid]+(1))', Type: 'bigint' })
    // Only its default differs: no ALTER COLUMN, so the computed column is not in the way.
    .column('T', 'OnlyDefault', { Default: '((5))' })
    .column('T', 'OnlyDefaultPlus', { Computed: '([OnlyDefault]+(1))' })
    // Names that need quoting, and a name that is only part of another.
    .column('T', 'we]ird col', { Type: 'bigint' })
    .column('T', 'Weird', { Computed: '([we]]ird col]+[Other])' })
    .column('T', 'Q', { Type: 'bigint' })
    .column('T', 'NotQ', { Computed: '([Q2]+[OtherQ])' })
    // Read without VIEW DEFINITION: nobody knows what it uses, so it is not counted.
    .column('T', 'Unknown', { Computed: HIDDEN });
  const target = snapshot().database('Thai_CI_AS').table('T')
    .column('T', 'Base', { Nullable: 'NOT NULL' })
    .column('T', 'Dflt', { Default: '((1))' }, { DefaultName: 'DF_T_Dflt' })
    .column('T', 'DfltTwice', { Computed: '([Dflt]*(2))', Persisted: 'PERSISTED' })
    .column('T', 'Hid', { Default: '((1))' })
    .column('T', 'HidPlus', { Computed: '([Hid]+(1))' })
    .column('T', 'OnlyDefault', { Default: '((4))' })
    .column('T', 'OnlyDefaultPlus', { Computed: '([OnlyDefault]+(1))' })
    .column('T', 'we]ird col', {})
    // Written in another case than the column is called: SQL Server keeps what was typed.
    .column('T', 'Weird', { Computed: '([WE]]IRD COL]+[Other])' })
    .column('T', 'Q', {})
    .column('T', 'NotQ', { Computed: '([Q2]+[OtherQ])' })
    .column('T', 'Unknown', { Computed: HIDDEN })
    // Only here, and it uses Base: the sync script leaves it, so it is added again as it is.
    .column('T', 'Legacy', { Computed: '([Base]-(1))' });
  const s = scriptsFor('computed-dependents', source, target);

  const active = statements(s.sync);
  assert.deepEqual(active, [
    'ALTER TABLE [dbo].[T] ADD [Added] int NULL;',
    // Base: nothing active. The target's Legacy uses it.
    ...inTransaction(...dropDefault('OnlyDefault'), 'ALTER TABLE [dbo].[T] ADD DEFAULT ((5)) FOR [OnlyDefault];'),
    // No computed column uses Q: [Q2] and [OtherQ] are other names.
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Q] bigint NULL;',
    // After every changed column.
    'ALTER TABLE [dbo].[T] ADD [BaseNew] AS ([Base]+(1));',
  ]);
  assert.deepEqual(byHandLines(s.sync, 'Base'), [
    '-- BEGIN TRANSACTION;',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Legacy];',
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [Base] bigint NOT NULL;',
    '-- ALTER TABLE [dbo].[T] ADD [Legacy] AS ([Base]-(1));',
    '-- COMMIT TRANSACTION;',
  ]);
  assert.deepEqual(byHandLines(s.sync, 'Dflt'), [
    '-- BEGIN TRANSACTION;',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [DfltTwice];',
    ...dropDefault('Dflt').map((l) => `-- ${l}`),
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [Dflt] bigint NULL;',
    '-- ALTER TABLE [dbo].[T] ADD CONSTRAINT [DF_T_Dflt] DEFAULT ((1)) FOR [Dflt];',
    '-- ALTER TABLE [dbo].[T] ADD [DfltTwice] AS ([Dflt]*(2)) PERSISTED;',
    '-- COMMIT TRANSACTION;',
  ]);
  // No transaction to offer: the default cannot be added again.
  assert.deepEqual(byHandLines(s.sync, 'Hid'), [
    '-- Not scripted: the type change needs the default of the column dropped first, and the default the column has in the source is not readable, so it cannot be added again. By hand: run these, then add the default:',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [HidPlus];',
    ...dropDefault('Hid').map((l) => `-- ${l}`),
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [Hid] bigint NULL;',
    '-- ALTER TABLE [dbo].[T] ADD [HidPlus] AS ([Hid]+(1));',
  ]);
  assert.deepEqual(byHandLines(s.sync, 'we]ird col'), [
    '-- BEGIN TRANSACTION;',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Weird];',
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [we]]ird col] bigint NULL;',
    '-- ALTER TABLE [dbo].[T] ADD [Weird] AS ([we]]ird col]+[Other]);',
    '-- COMMIT TRANSACTION;',
  ]);
  assert.equal(comments(s.sync).filter((l) => l.startsWith('-- Not run: computed column')).length, 4, s.sync);

  // The rollback runs on what the sync script left: Legacy is still there (a sync script drops
  // no column) and BaseNew has been added (a rollback drops none either). Both use Base.
  assert.deepEqual(byHandLines(s.rollback, 'Base'), [
    '-- BEGIN TRANSACTION;',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [BaseNew];',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Legacy];',
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [Base] int NOT NULL;',
    '-- ALTER TABLE [dbo].[T] ADD [BaseNew] AS ([Base]+(1));',
    '-- ALTER TABLE [dbo].[T] ADD [Legacy] AS ([Base]-(1));',
    '-- COMMIT TRANSACTION;',
  ]);
  assert.ok(!statements(s.rollback).some((l) => /ALTER COLUMN \[(Base|Dflt|Hid|we\]\]ird col)\]/.test(l)), s.rollback);
  assert.ok(statements(s.rollback).includes('ALTER TABLE [dbo].[T] ALTER COLUMN [Q] int NULL;'), s.rollback);
});

test('script: a new persisted computed column keeps NOT NULL', () => {
  const source = snapshot().database('Thai_CI_AS').table('T').table('New')
    .column('T', 'Qty', { Nullable: 'NOT NULL' })
    .column('T', 'Twice', { Computed: '([Qty]*(2))', Persisted: 'PERSISTED', Nullable: 'NOT NULL' })
    .column('T', 'Plain', { Computed: '([Qty]+(1))', Persisted: 'PERSISTED' })
    // Not persisted: NOT NULL cannot be declared, it follows from the expression.
    .column('T', 'Derived', { Computed: '(isnull([Qty],(0)))', Nullable: 'NOT NULL' })
    .column('New', 'Qty', { Nullable: 'NOT NULL' })
    .column('New', 'Twice', { Computed: '([Qty]*(2))', Persisted: 'PERSISTED', Nullable: 'NOT NULL' });
  const target = snapshot().database('Thai_CI_AS').table('T').column('T', 'Qty', { Nullable: 'NOT NULL' });
  const s = scriptsFor('computed-not-null', source, target);
  assert.deepEqual(statements(s.sync), [
    'CREATE TABLE [dbo].[New] (',
    '    [Qty] int NOT NULL,',
    '    [Twice] AS ([Qty]*(2)) PERSISTED NOT NULL',
    ');',
    'ALTER TABLE [dbo].[T] ADD [Derived] AS (isnull([Qty],(0)));',
    'ALTER TABLE [dbo].[T] ADD [Plain] AS ([Qty]+(1)) PERSISTED;',
    'ALTER TABLE [dbo].[T] ADD [Twice] AS ([Qty]*(2)) PERSISTED NOT NULL;',
  ]);
});

// ---------------------------------------------------------------------------------------------
// A column of a user-defined type the login cannot see. The catalog shows the column but not the
// name of its type, which then reads as "(not readable)": no statement is made up from that.
// ---------------------------------------------------------------------------------------------

test('script: a column whose type is not readable is not added, created or altered', () => {
  const HIDDEN = '(not readable)';
  // The source was read by the login that cannot see dbo.tCode.
  const source = snapshot().database('Thai_CI_AS').table('T').table('New')
    .column('T', 'Id', { Nullable: 'NOT NULL' })
    // The same column on both sides as far as can be seen.
    .column('T', 'Same', { Type: HIDDEN })
    // NULL / NOT NULL differs, which is compared; the type is not.
    .column('T', 'Code', { Type: HIDDEN, Nullable: 'NOT NULL' })
    // Only its default differs: that needs no type.
    .column('T', 'Dflt', { Type: HIDDEN, Default: "('a')" })
    .column('T', 'Added', { Type: HIDDEN })
    .column('New', 'Id', { Nullable: 'NOT NULL' })
    .column('New', 'Code', { Type: HIDDEN });
  const target = snapshot().database('Thai_CI_AS').table('T')
    .column('T', 'Id', { Nullable: 'NOT NULL' })
    .column('T', 'Same', { Type: 'dbo.tCode' })
    .column('T', 'Code', { Type: 'dbo.tCode' })
    .column('T', 'Dflt', { Type: 'dbo.tCode' });
  const s = scriptsFor('type-not-readable', source, target);

  assert.equal(s.statuses['dbo.T.Same'], 'Unverified');
  assert.equal(s.details['dbo.T.Same'], 'Type: not readable on source');
  assert.equal(s.statuses['dbo.T.Code'], 'Different');
  assert.equal(s.details['dbo.T.Code'], 'Nullable: source NOT NULL, target NULL\nType: not readable on source (not compared)');
  assert.equal(s.statuses['dbo.T.Added'], 'OnlyInSource');

  // The new table is created without the column that cannot be written, which is named in a
  // comment. The default is put on its column: that needs no type.
  assert.deepEqual(statements(s.sync), [
    'CREATE TABLE [dbo].[New] (',
    '    [Id] int NOT NULL',
    '    -- the type of column Code is not readable (a user-defined type the login has no permission on)',
    ');',
    ...inTransaction(...dropDefault('Dflt'), "ALTER TABLE [dbo].[T] ADD DEFAULT ('a') FOR [Dflt];"),
  ]);
  for (const script of [s.sync, s.rollback]) {
    assert.ok(!statements(script).some((l) => l.includes(HIDDEN)), script);
    assert.ok(!statements(script).some((l) => /ALTER COLUMN|ADD \[(?:Added|Code)\]/.test(l)), script);
  }
  assert.ok(comments(s.sync).includes('-- Not scripted: the type of column dbo.T.Added is not readable (a user-defined type the login has no permission on)'), s.sync);
  assert.equal(comments(s.sync).filter((l) => l.startsWith('-- Not scripted: the type of this column is not readable on one side')).length, 1, s.sync);
  assert.equal(comments(s.rollback).filter((l) => l.startsWith('-- Not scripted: the type of this column is not readable on one side')).length, 1, s.rollback);
});

// ---------------------------------------------------------------------------------------------
// Defaults. A default is in the way of a type change (Msg 5074): it is dropped first and added
// again afterwards, all in one transaction, so a statement that fails leaves the default there.
// ---------------------------------------------------------------------------------------------

// The batch lines that drop whatever default a column has (its name is looked up when it runs).
function dropDefault(column: string): string[] {
  return [
    'DECLARE @default sysname, @drop nvarchar(max);',
    `SELECT @default = dc.name FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID(N'[dbo].[T]') AND c.name = N'${column}';`,
    "IF @default IS NOT NULL BEGIN SET @drop = N'ALTER TABLE [dbo].[T] DROP CONSTRAINT ' + QUOTENAME(@default); EXEC (@drop); END",
  ];
}

function inTransaction(...lines: string[]): string[] {
  return ['BEGIN TRANSACTION;', ...lines, 'COMMIT TRANSACTION;'];
}

test('script: a default is dropped for a type change and put back, in one transaction', () => {
  const HIDDEN = '(not readable)';
  const source = snapshot().database('Thai_CI_AS').table('T')
    .column('T', 'Both', { Type: 'bigint', Default: '((2))' })
    .column('T', 'Gone', { Type: 'bigint' })
    .column('T', 'NoDefault', {})
    .column('T', 'Nullable', { Nullable: 'NOT NULL', Default: '((0))' })
    .column('T', 'OnlyDefault', { Default: '((5))' }, { DefaultName: 'DF_T_OnlyDefault' })
    .column('T', 'Same', { Type: 'bigint', Nullable: 'NOT NULL', Default: '((1))' }, { DefaultName: 'DF_T_Same' })
    .column('T', 'SourceHidden', { Type: 'bigint', Default: HIDDEN })
    .column('T', 'TargetHidden', { Type: 'bigint', Default: '((7))' })
    .column('T', 'Wider', { Type: 'varchar(20)', Collation: 'Thai_CI_AS' });
  const target = snapshot().database('Thai_CI_AS').table('T')
    .column('T', 'Both', { Type: 'int', Default: '((1))' })
    .column('T', 'Gone', { Type: 'int', Default: '((1))' })
    .column('T', 'NoDefault', { Default: '((4))' })
    .column('T', 'Nullable', { Default: '((0))' })
    .column('T', 'OnlyDefault', { Default: '((4))' })
    .column('T', 'Same', { Type: 'int', Nullable: 'NOT NULL', Default: '((1))' }, { DefaultName: 'DF_T_Same_before' })
    .column('T', 'SourceHidden', { Type: 'int', Default: '((1))' })
    .column('T', 'TargetHidden', { Type: 'int', Default: HIDDEN })
    .column('T', 'Wider', { Type: 'varchar(10)', Collation: 'Thai_CI_AS' });
  const s = scriptsFor('defaults', source, target);

  assert.deepEqual(statements(s.sync), [
    // Type and default differ.
    ...inTransaction(...dropDefault('Both'), 'ALTER TABLE [dbo].[T] ALTER COLUMN [Both] bigint NULL;', 'ALTER TABLE [dbo].[T] ADD DEFAULT ((2)) FOR [Both];'),
    // The source has no default.
    ...inTransaction(...dropDefault('Gone'), 'ALTER TABLE [dbo].[T] ALTER COLUMN [Gone] bigint NULL;'),
    // Only the default goes: one statement group, nothing to protect.
    ...dropDefault('NoDefault'),
    // NULL / NOT NULL can change with the default in place.
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Nullable] int NOT NULL;',
    // Only the default differs: the new one can fail too (a function that is not there).
    ...inTransaction(...dropDefault('OnlyDefault'), 'ALTER TABLE [dbo].[T] ADD CONSTRAINT [DF_T_OnlyDefault] DEFAULT ((5)) FOR [OnlyDefault];'),
    // The same default on both sides: only the type differs, and still the default has to move.
    ...inTransaction(...dropDefault('Same'), 'ALTER TABLE [dbo].[T] ALTER COLUMN [Same] bigint NOT NULL;', 'ALTER TABLE [dbo].[T] ADD CONSTRAINT [DF_T_Same] DEFAULT ((1)) FOR [Same];'),
    // SourceHidden: nothing. The default to put back cannot be read.
    // TargetHidden: nothing either. The default that would be dropped cannot be read, so nobody
    // knows what goes, and the rollback script could not put it back.
    // No default: as before.
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Wider] varchar(20) COLLATE Thai_CI_AS NULL;',
  ]);
  // What was left out is there to read, as comments.
  assert.equal(comments(s.sync).filter((l) => /^-- Not scripted: .*default.* not readable/.test(l)).length, 2, s.sync);
  for (const line of [
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [SourceHidden] bigint NULL;',
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [TargetHidden] bigint NULL;',
    '-- ALTER TABLE [dbo].[T] ADD DEFAULT ((7)) FOR [TargetHidden];',
  ]) assert.ok(comments(s.sync).includes(line), `${line} expected in:\n${s.sync}`);

  assert.deepEqual(statements(s.rollback), [
    ...inTransaction(...dropDefault('Both'), 'ALTER TABLE [dbo].[T] ALTER COLUMN [Both] int NULL;', 'ALTER TABLE [dbo].[T] ADD DEFAULT ((1)) FOR [Both];'),
    ...inTransaction(...dropDefault('Gone'), 'ALTER TABLE [dbo].[T] ALTER COLUMN [Gone] int NULL;', 'ALTER TABLE [dbo].[T] ADD DEFAULT ((1)) FOR [Gone];'),
    ...inTransaction(...dropDefault('NoDefault'), 'ALTER TABLE [dbo].[T] ADD DEFAULT ((4)) FOR [NoDefault];'),
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Nullable] int NULL;',
    ...inTransaction(...dropDefault('OnlyDefault'), 'ALTER TABLE [dbo].[T] ADD DEFAULT ((4)) FOR [OnlyDefault];'),
    ...inTransaction(...dropDefault('Same'), 'ALTER TABLE [dbo].[T] ALTER COLUMN [Same] int NOT NULL;', 'ALTER TABLE [dbo].[T] ADD CONSTRAINT [DF_T_Same_before] DEFAULT ((1)) FOR [Same];'),
    // SourceHidden and TargetHidden: nothing, as in the sync script. One side's default cannot be
    // read, whichever script it is.
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Wider] varchar(10) COLLATE Thai_CI_AS NULL;',
  ]);
  assert.equal(comments(s.rollback).filter((l) => /^-- Not scripted: .*default.* not readable/.test(l)).length, 2, s.rollback);
  for (const line of [
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [SourceHidden] int NULL;',
    '-- ALTER TABLE [dbo].[T] ADD DEFAULT ((1)) FOR [SourceHidden];',
    '-- ALTER TABLE [dbo].[T] ALTER COLUMN [TargetHidden] int NULL;',
  ]) assert.ok(comments(s.rollback).includes(line), `${line} expected in:\n${s.rollback}`);
});

// ---------------------------------------------------------------------------------------------
// Sequences of a decimal or numeric type. The precision is part of the type: "AS decimal" alone
// is decimal(18,0), and the limits of a wider sequence do not fit that (Msg 11708).
// ---------------------------------------------------------------------------------------------

test('script: a decimal or numeric sequence is created with its precision', () => {
  const wide = { Min: '-9999999999999999999999999999', Max: '9999999999999999999999999999' };
  const source = snapshot().database('Thai_CI_AS')
    .sequence('seqBig', 'dbo', { DataType: 'decimal', Precision: '28', ...wide })
    .sequence('seqNum', 'dbo', { DataType: 'numeric', Precision: '10' })
    // Read by an engine that did not know the precision yet: written as it was then.
    .sequence('seqOld', 'dbo', { DataType: 'decimal' })
    .sequence('seqInt', 'dbo', { DataType: 'int' })
    // The precision differs: reported, and nothing can change it short of creating the sequence again.
    .sequence('seqWider', 'dbo', { DataType: 'decimal', Precision: '28' })
    // A default takes its value from it, and sequences are not compared in the second run below.
    .table('T').column('T', 'Id', { Type: 'decimal(28,0)', Nullable: 'NOT NULL', Default: '(NEXT VALUE FOR [dbo].[seqBig])' });
  const target = snapshot().database('Thai_CI_AS').sequence('seqWider', 'dbo', { DataType: 'decimal', Precision: '18' });
  const rest = 'START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 1000 NO CYCLE CACHE;';
  const big = `CREATE SEQUENCE [dbo].[seqBig] AS decimal(28,0) START WITH 1 INCREMENT BY 1 MINVALUE ${wide.Min} MAXVALUE ${wide.Max} NO CYCLE CACHE;`;

  const s = scriptsFor('sequence-precision', source, target);
  assert.equal(s.details['dbo.seqWider'], 'Precision: source 28, target 18');
  assert.deepEqual(statements(s.sync).filter((l) => l.includes('SEQUENCE')), [
    big,
    `CREATE SEQUENCE [dbo].[seqInt] AS int ${rest}`,
    `CREATE SEQUENCE [dbo].[seqNum] AS numeric(10,0) ${rest}`,
    `CREATE SEQUENCE [dbo].[seqOld] AS decimal ${rest}`,
    'ALTER SEQUENCE [dbo].[seqWider] INCREMENT BY 1 MINVALUE 1 MAXVALUE 1000 NO CYCLE CACHE;  -- data type and start value are not changed',
  ]);

  // Created only because the new table needs it: the same statement.
  const needed = scriptsFor('sequence-precision-needed', source, target, { categories: 'Table,Column' });
  assert.deepEqual(statements(needed.sync).filter((l) => l.includes('SEQUENCE')), [`IF OBJECT_ID(N'[dbo].[seqBig]', N'SO') IS NULL ${big}`]);
});

// ---------------------------------------------------------------------------------------------
// Types and sequences that new tables and columns use. When those categories are not compared
// (they are not, by default) nothing lists them as missing, and the script must still create the
// ones its own statements need.
// ---------------------------------------------------------------------------------------------

test('script: types and sequences that new tables and columns use are created when missing', () => {
  const sequenceSql = (name: string) => `CREATE SEQUENCE ${name} AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 1000 NO CYCLE CACHE;`;
  const source = snapshot().database('Thai_CI_AS').schema('ref')
    .aliasType('tPhone', 'varchar(20) NULL')
    .aliasType('tCode', 'char(3) NOT NULL', 'ref')
    .aliasType('tBoth', 'int NULL')
    .aliasType('tUnused', 'int NULL')
    .sequence('seqNew').sequence('seqChanged').sequence('seqBoth').sequence('seqUnused').sequence('seqRef', 'ref')
    .table('New')
    .column('New', 'Id', { Type: 'bigint', Nullable: 'NOT NULL', Default: '(NEXT VALUE FOR [dbo].[seqNew])' })
    .column('New', 'Phone', { Type: 'dbo.tPhone', Collation: 'Thai_CI_AS' })
    .table('T')
    // A new column, of a type in a schema the target does not have either.
    .column('T', 'Added', { Type: 'ref.tCode', Nullable: 'NOT NULL', Collation: 'Thai_CI_AS', Default: '(NEXT VALUE FOR [ref].[seqRef])' })
    // Changed columns: another type (the same as New.Phone: created once), a type both sides have.
    .column('T', 'Changed', { Type: 'dbo.tPhone', Collation: 'Thai_CI_AS' })
    .column('T', 'Both', { Type: 'dbo.tBoth', Nullable: 'NOT NULL' })
    // A default that differs and takes its value from a sequence only the source has.
    .column('T', 'Seq', { Type: 'bigint', Default: '(NEXT VALUE FOR [dbo].[seqChanged])' })
    // Written without a schema, a sequence both sides have, one in another database: nothing to create.
    .column('T', 'OnePart', { Type: 'bigint', Default: '(NEXT VALUE FOR [seqBoth])' })
    .column('T', 'Elsewhere', { Type: 'bigint', Default: '(NEXT VALUE FOR [otherdb].[dbo].[seqNew])' });
  const target = snapshot().database('Thai_CI_AS')
    .aliasType('tBoth', 'int NULL')
    .sequence('seqBoth')
    .table('T')
    .column('T', 'Changed', { Type: 'varchar(20)', Collation: 'Thai_CI_AS' })
    .column('T', 'Both', { Type: 'dbo.tBoth' })
    .column('T', 'Seq', { Type: 'bigint' });

  const s = scriptsFor('needed-types', source, target, { categories: 'Table,Column' });
  const lines = statements(s.sync);
  assert.deepEqual(lines.slice(0, 6), [
    // The schema of a type and a sequence that are needed, though no new object is in it.
    "IF SCHEMA_ID(N'ref') IS NULL EXEC (N'CREATE SCHEMA [ref]');",
    "IF TYPE_ID(N'[dbo].[tPhone]') IS NULL CREATE TYPE [dbo].[tPhone] FROM varchar(20) NULL;",
    "IF TYPE_ID(N'[ref].[tCode]') IS NULL CREATE TYPE [ref].[tCode] FROM char(3) NOT NULL;",
    `IF OBJECT_ID(N'[dbo].[seqChanged]', N'SO') IS NULL ${sequenceSql('[dbo].[seqChanged]')}`,
    `IF OBJECT_ID(N'[dbo].[seqNew]', N'SO') IS NULL ${sequenceSql('[dbo].[seqNew]')}`,
    `IF OBJECT_ID(N'[ref].[seqRef]', N'SO') IS NULL ${sequenceSql('[ref].[seqRef]')}`,
  ], s.sync);
  assert.equal(lines[6], 'CREATE TABLE [dbo].[New] (', s.sync);
  for (const name of ['tBoth', 'tUnused', 'seqBoth', 'seqUnused']) assert.ok(!lines.some((l) => l.includes(`CREATE`) && l.includes(`[${name}]`)), `${name} must not be created:\n${s.sync}`);

  // The rollback script leaves them, as it leaves the schema: it says so, and drops nothing.
  assert.match(s.rollback, /Schemas, types and sequences it created only when missing are left in place\./);
  assert.ok(!/DROP (TYPE|SEQUENCE|SCHEMA)/.test(s.rollback), s.rollback);

  // Compared, they are in the list of differences and created as such: every one the target
  // lacks, used or not, and none a second time.
  const all = statements(scriptsFor('needed-types-compared', source, target).sync);
  assert.ok(!all.some((l) => /^IF (TYPE_ID|OBJECT_ID|SCHEMA_ID)/.test(l)), all.join('\n'));
  for (const line of [
    'CREATE SCHEMA [ref];', 'CREATE TYPE [dbo].[tPhone] FROM varchar(20) NULL;', 'CREATE TYPE [dbo].[tUnused] FROM int NULL;',
    'CREATE TYPE [ref].[tCode] FROM char(3) NOT NULL;', sequenceSql('[dbo].[seqNew]'), sequenceSql('[dbo].[seqUnused]'), sequenceSql('[ref].[seqRef]'),
  ]) assert.equal(all.filter((l) => l === line).length, 1, `${line}\n${all.join('\n')}`);
});

// ---------------------------------------------------------------------------------------------
// Synonyms. One that points into another database or to another server is written as a comment:
// the name of that database is what differs between a development and a production server, and a
// script that repoints a production synonym at the development database must not do it unasked.
// ---------------------------------------------------------------------------------------------

test('script: a synonym for an object in another database is left commented out', () => {
  const source = snapshot()
    .synonym('synLocalNew', '[dbo].[Orders]')
    .synonym('synLocalChanged', '[dbo].[vOrders]')
    .synonym('synRemoteNew', '[otherdb_dev].[dbo].[Orders]')
    .synonym('synServerNew', '[srv].[otherdb].[dbo].[Orders]')
    .synonym('synRemoteChanged', '[otherdb_dev].[dbo].[Orders]')
    // Only one side names another database: both scripts leave it, so they stay each other's mirror.
    .synonym('synToRemote', '[otherdb_dev].[dbo].[Orders]')
    .synonym('synToLocal', '[dbo].[Orders]');
  const target = snapshot()
    .synonym('synLocalChanged', '[dbo].[Orders]')
    .synonym('synRemoteChanged', '[otherdb_prod].[dbo].[Orders]')
    .synonym('synToRemote', '[dbo].[Orders]')
    .synonym('synToLocal', '[otherdb_prod].[dbo].[Orders]');
  const s = scriptsFor('synonyms', source, target);

  assert.deepEqual(statements(s.sync), [
    'CREATE SYNONYM [dbo].[synLocalNew] FOR [dbo].[Orders];',
    'DROP SYNONYM [dbo].[synLocalChanged];',
    'CREATE SYNONYM [dbo].[synLocalChanged] FOR [dbo].[vOrders];',
  ]);
  for (const line of [
    '-- CREATE SYNONYM [dbo].[synRemoteNew] FOR [otherdb_dev].[dbo].[Orders];',
    '-- CREATE SYNONYM [dbo].[synServerNew] FOR [srv].[otherdb].[dbo].[Orders];',
    '-- DROP SYNONYM [dbo].[synRemoteChanged];',
    '-- CREATE SYNONYM [dbo].[synRemoteChanged] FOR [otherdb_dev].[dbo].[Orders];',
    '-- DROP SYNONYM [dbo].[synToRemote];',
    '-- CREATE SYNONYM [dbo].[synToRemote] FOR [otherdb_dev].[dbo].[Orders];',
    '-- DROP SYNONYM [dbo].[synToLocal];',
    '-- CREATE SYNONYM [dbo].[synToLocal] FOR [dbo].[Orders];',
  ]) assert.ok(comments(s.sync).includes(line), `${line} expected in:\n${s.sync}`);

  // The rollback: drops what the sync script created (also a synonym someone ran by hand from its
  // comment), puts back the local one, and leaves the same three changed ones as comments.
  assert.deepEqual(statements(s.rollback), [
    'DROP SYNONYM IF EXISTS [dbo].[synLocalNew];',
    'DROP SYNONYM IF EXISTS [dbo].[synRemoteNew];',
    'DROP SYNONYM IF EXISTS [dbo].[synServerNew];',
    'DROP SYNONYM [dbo].[synLocalChanged];',
    'CREATE SYNONYM [dbo].[synLocalChanged] FOR [dbo].[Orders];',
  ]);
  for (const line of [
    '-- CREATE SYNONYM [dbo].[synRemoteChanged] FOR [otherdb_prod].[dbo].[Orders];',
    '-- CREATE SYNONYM [dbo].[synToRemote] FOR [dbo].[Orders];',
    '-- CREATE SYNONYM [dbo].[synToLocal] FOR [otherdb_prod].[dbo].[Orders];',
  ]) assert.ok(comments(s.rollback).includes(line), `${line} expected in:\n${s.rollback}`);
});

// ---------------------------------------------------------------------------------------------
// Modules that ALTER cannot turn into what the source has: a trigger that is on another table,
// an object of another type (a scalar function that became table-valued). Nothing is run for
// them: the drop and the new CREATE are written as comments, with the names the catalog has.
// ---------------------------------------------------------------------------------------------

test('script: a trigger that is on another table in the target is explained, not altered', () => {
  const body = 'AFTER INSERT AS\r\nSET NOCOUNT ON;\r\n';
  const source = snapshot().table('A').table('B')
    .trigger('trMoved', 'A', `CREATE TRIGGER dbo.trMoved ON dbo.A ${body}`)
    // Its text still names the table as it was called before a rename; disabled in the source.
    .trigger('trStale', 'A', `CREATE TRIGGER dbo.trStale ON dbo.AOld ${body}`, 'DISABLED', 'ANSI_NULLS OFF')
    // Another table and another body: still not something ALTER can do.
    .trigger('trBoth', 'A', 'CREATE TRIGGER dbo.trBoth ON dbo.A AFTER UPDATE AS RETURN');
  const target = snapshot().table('A').table('B')
    .trigger('trMoved', 'B', `CREATE TRIGGER dbo.trMoved ON dbo.B ${body}`)
    .trigger('trStale', 'B', `CREATE TRIGGER dbo.trStale ON dbo.B ${body}`)
    .trigger('trBoth', 'B', 'CREATE TRIGGER dbo.trBoth ON dbo.B AFTER INSERT AS RETURN');
  const s = scriptsFor('trigger-moved', source, target);

  assert.equal(s.details['dbo.trMoved'], 'Table: source dbo.A, target dbo.B');
  assert.deepEqual(statements(s.sync), [], s.sync);
  const text = comments(s.sync);
  assert.equal(text.filter((l) => /ALTER cannot move a trigger/.test(l)).length, 3, s.sync);
  for (const line of [
    '-- DROP TRIGGER [dbo].[trMoved];',
    '-- CREATE TRIGGER dbo.trMoved ON dbo.A AFTER INSERT AS',
    '-- SET NOCOUNT ON;',
    '-- DROP TRIGGER [dbo].[trStale];',
    '-- SET ANSI_NULLS OFF;',
    '-- CREATE TRIGGER dbo.trStale ON [dbo].[A] AFTER INSERT AS',
    '-- DISABLE TRIGGER [dbo].[trStale] ON [dbo].[A];',
    '-- DROP TRIGGER [dbo].[trBoth];',
    '-- CREATE TRIGGER dbo.trBoth ON dbo.A AFTER UPDATE AS RETURN',
  ]) assert.ok(text.includes(line), `${line} expected in:\n${s.sync}`);

  assert.deepEqual(statements(s.rollback), [], s.rollback);
  for (const line of ['-- DROP TRIGGER [dbo].[trMoved];', '-- CREATE TRIGGER dbo.trMoved ON dbo.B AFTER INSERT AS', '-- CREATE TRIGGER dbo.trBoth ON dbo.B AFTER INSERT AS RETURN']) {
    assert.ok(comments(s.rollback).includes(line), `${line} expected in:\n${s.rollback}`);
  }
});

test('script: an object of another type is dropped and created again by hand, from statements with the right name', () => {
  const source = snapshot()
    // Renamed with sp_rename: its text still says fOld.
    .module('Function', 'fKind', 'IF', 'SQL_INLINE_TABLE_VALUED_FUNCTION', 'CREATE FUNCTION dbo.fOld ()\r\nRETURNS TABLE AS RETURN SELECT 1 AS One;');
  const target = snapshot()
    .module('Function', 'fKind', 'FN', 'SQL_SCALAR_FUNCTION', 'CREATE FUNCTION dbo.fKind () RETURNS int AS BEGIN RETURN 1; END;');
  const s = scriptsFor('type-changed', source, target);

  assert.deepEqual(statements(s.sync), [], s.sync);
  for (const line of ['-- DROP FUNCTION [dbo].[fKind];', '-- CREATE FUNCTION [dbo].[fKind] ()', '-- RETURNS TABLE AS RETURN SELECT 1 AS One;']) {
    assert.ok(comments(s.sync).includes(line), `${line} expected in:\n${s.sync}`);
  }
  // Not "copy it from the report": the report shows the text with the name it had before.
  assert.ok(!/from the report/.test(s.sync), s.sync);
  assert.ok(comments(s.rollback).includes('-- CREATE FUNCTION dbo.fKind () RETURNS int AS BEGIN RETURN 1; END;'), s.rollback);
});

// ---------------------------------------------------------------------------------------------
// A constraint that only has to be enabled. WITH CHECK validates the rows that are there; when
// they break the constraint it fails (Msg 547) and the constraint stays disabled.
// ---------------------------------------------------------------------------------------------

test('script: enabling a constraint comes with the statement that does not check existing rows, as a comment', () => {
  const source = snapshot().table('T')
    .check('T', 'CK_On', '([Qty]>(0))', 'ENABLED')
    .check('T', 'CK_Off', '([Qty]<(9))', 'DISABLED');
  const target = snapshot().table('T')
    .check('T', 'CK_On', '([Qty]>(0))', 'DISABLED')
    .check('T', 'CK_Off', '([Qty]<(9))', 'ENABLED');
  const s = scriptsFor('constraint-state', source, target);

  assert.deepEqual(statements(s.sync), [
    'ALTER TABLE [dbo].[T] NOCHECK CONSTRAINT [CK_Off];',
    'ALTER TABLE [dbo].[T] WITH CHECK CHECK CONSTRAINT [CK_On];',
  ]);
  assert.deepEqual(comments(s.sync).filter((l) => / CHECK CONSTRAINT /.test(l)), ['-- ALTER TABLE [dbo].[T] CHECK CONSTRAINT [CK_On];']);
  // The rollback enables the one the sync script disabled: before, it may have been enabled
  // without being trusted, over rows that break it.
  assert.deepEqual(statements(s.rollback), [
    'ALTER TABLE [dbo].[T] WITH CHECK CHECK CONSTRAINT [CK_Off];',
    'ALTER TABLE [dbo].[T] NOCHECK CONSTRAINT [CK_On];',
  ]);
  assert.deepEqual(comments(s.rollback).filter((l) => / CHECK CONSTRAINT /.test(l)), ['-- ALTER TABLE [dbo].[T] CHECK CONSTRAINT [CK_Off];']);
});

// ---------------------------------------------------------------------------------------------
// Table types. A new one is written with everything the engine reads of it; one from a snapshot
// that holds only its columns (saved before 2026-11-11) is written as far as that goes, and says so.
// ---------------------------------------------------------------------------------------------

test('script: a table type is written with its collations and key options, or with a note when the snapshot lacks them', () => {
  const read = {
    details: 'Qty DEFAULT ((1)); PRIMARY KEY CLUSTERED (Id) WITH (IGNORE_DUP_KEY = ON); UNIQUE NONCLUSTERED (Code DESC)',
    collation: 'Code Latin1_General_BIN; Note Thai_CI_AS; Alias Thai_CI_AS',
    keys: [
      { Kind: 'PRIMARY KEY', Type: 'CLUSTERED', IgnoreDupKey: true, Columns: [{ Name: 'Id', Desc: false }] },
      { Kind: 'UNIQUE', Type: 'NONCLUSTERED', IgnoreDupKey: false, Columns: [{ Name: 'Code', Desc: true }] },
    ],
  };
  const source = snapshot().database('SQL_Latin1_General_CP1_CI_AS')
    .tableType('tNew', [
      { Name: 'Id', Type: 'int', Nullable: 'NOT NULL' },
      // A collation of its own, the collation of the target database, and a user-defined type
      // (COLLATE cannot be written for one).
      { Name: 'Code', Type: 'varchar(10)', Nullable: 'NOT NULL', Collation: 'Latin1_General_BIN' },
      { Name: 'Note', Type: 'nvarchar(20)', Nullable: 'NULL', Collation: 'Thai_CI_AS' },
      { Name: 'Alias', Type: 'dbo.tCode', Nullable: 'NULL', Collation: 'Thai_CI_AS' },
      { Name: 'Qty', Type: 'int', Nullable: 'NOT NULL', Default: '((1))' },
    ], read)
    .tableType('tOld', [{ Name: 'Id', Type: 'int', Nullable: 'NOT NULL' }, { Name: 'Code', Type: 'varchar(10)', Nullable: 'NULL' }]);
  const target = snapshot().database('Thai_CI_AS');
  const s = scriptsFor('table-types', source, target);

  assert.deepEqual(statements(s.sync), [
    'CREATE TYPE [dbo].[tNew] AS TABLE (',
    '    [Id] int NOT NULL,',
    '    [Code] varchar(10) COLLATE Latin1_General_BIN NOT NULL,',
    '    [Note] nvarchar(20) NULL,',
    '    [Alias] [dbo].[tCode] NULL,',
    '    [Qty] int NOT NULL DEFAULT ((1)),',
    '    PRIMARY KEY CLUSTERED ([Id]) WITH (IGNORE_DUP_KEY = ON),',
    '    UNIQUE NONCLUSTERED ([Code] DESC)',
    ');',
    'CREATE TYPE [dbo].[tOld] AS TABLE (',
    '    [Id] int NOT NULL,',
    '    [Code] varchar(10) NULL',
    ');',
  ]);
  // Only the type whose snapshot lacks them says that keys and defaults are missing.
  const notes = comments(s.sync);
  const missing = notes.findIndex((l) => /^-- This snapshot was saved before .* keys and checks are NOT in the statement below/.test(l));
  assert.equal(notes.filter((l) => /^-- This snapshot was saved before/.test(l)).length, 1, s.sync);
  assert.ok(missing > notes.findIndex((l) => /^-- Table type: /.test(l)), s.sync);
  assert.ok(s.sync.indexOf('This snapshot was saved before') > s.sync.indexOf('CREATE TYPE [dbo].[tNew]'), 'the note belongs to tOld');

  // With -IgnoreCollation no collation is written: the type gets the target database's.
  const ignoring = statements(scriptsFor('table-types-ignore-collation', source, target, { options: ['-IgnoreCollation'] }).sync);
  assert.equal(ignoring[2], '    [Code] varchar(10) NOT NULL,');
});

// ---------------------------------------------------------------------------------------------
// A module whose definition cannot be read on one side (no VIEW DEFINITION, WITH ENCRYPTION). Its
// SET options, type and table are still readable, and a difference in one of those must not make
// a script replace or drop a body nobody could compare, and that no rollback could put back.
// ---------------------------------------------------------------------------------------------

// The engine's marker for a definition that exists but cannot be read ($HiddenDefinition).
const HIDDEN_DEFINITION = '-- definition not available (encrypted, CLR, or no VIEW DEFINITION permission)';

test('script: a module that cannot be read on one side is not replaced because its SET options differ', () => {
  const procedure = 'SQL_STORED_PROCEDURE';
  const source = snapshot().table('A').table('B')
    .module('Stored procedure', 'pTargetHidden', 'P', procedure, 'CREATE PROCEDURE dbo.pTargetHidden AS SELECT "source body" AS Txt;', 'QUOTED_IDENTIFIER OFF')
    .module('Stored procedure', 'pSourceHidden', 'P', procedure, HIDDEN_DEFINITION)
    // The same for what needs a drop and a new CREATE: another type, a trigger on another table.
    .module('Function', 'fKind', 'IF', 'SQL_INLINE_TABLE_VALUED_FUNCTION', 'CREATE FUNCTION dbo.fKind () RETURNS TABLE AS RETURN SELECT 1 AS One;')
    .trigger('trMoved', 'A', 'CREATE TRIGGER dbo.trMoved ON dbo.A AFTER INSERT AS RETURN')
    // Readable on both sides: still scripted.
    .module('Stored procedure', 'pReadable', 'P', procedure, 'CREATE PROCEDURE dbo.pReadable AS SELECT 1;', 'ANSI_NULLS OFF');
  const target = snapshot().table('A').table('B')
    .module('Stored procedure', 'pTargetHidden', 'P', procedure, HIDDEN_DEFINITION)
    .module('Stored procedure', 'pSourceHidden', 'P', procedure, 'CREATE PROCEDURE dbo.pSourceHidden AS SELECT 1;', 'ANSI_NULLS OFF')
    .module('Function', 'fKind', 'FN', 'SQL_SCALAR_FUNCTION', HIDDEN_DEFINITION)
    .trigger('trMoved', 'B', HIDDEN_DEFINITION)
    .module('Stored procedure', 'pReadable', 'P', procedure, 'CREATE PROCEDURE dbo.pReadable AS SELECT 1;');
  const s = scriptsFor('unreadable-set-options', source, target);

  assert.equal(s.details['dbo.pTargetHidden'], 'SetOptions: source QUOTED_IDENTIFIER OFF, target (none)\nDefinition: not readable on target (not compared)');
  assert.deepEqual(statements(s.sync), [
    'SET ANSI_NULLS OFF;',
    'CREATE OR ALTER PROCEDURE dbo.pReadable AS SELECT 1;',
    'SET ANSI_NULLS ON;',
    'SET QUOTED_IDENTIFIER ON;',
  ], s.sync);
  assert.deepEqual(statements(s.rollback), ['CREATE OR ALTER PROCEDURE dbo.pReadable AS SELECT 1;'], s.rollback);
  for (const script of [s.sync, s.rollback]) {
    const notScripted = comments(script).filter((l) => /^-- Not scripted: /.test(l));
    assert.equal(notScripted.filter((l) => /SET options differ, but the definition is not readable on one side/.test(l)).length, 2, script);
    // One each for the function and the trigger, and nothing that tells anyone to drop them.
    assert.equal(notScripted.filter((l) => /dropped and created again, but its definition is not readable on one side/.test(l)).length, 2, script);
    assert.ok(!/DROP (PROCEDURE|FUNCTION|TRIGGER)/.test(script), script);
    assert.ok(!script.includes('source body'), script);
  }
});

// ---------------------------------------------------------------------------------------------
// Indexes of views and database triggers. The engine reads them since snapshot version 2. A file
// of version 1 holds neither, which does not mean that database had none: with such a file on
// one side they are left out of the comparison, and the run says so.
// ---------------------------------------------------------------------------------------------

const TOTALS_VIEW = 'CREATE VIEW dbo.vTotals WITH SCHEMABINDING AS SELECT Region, COUNT_BIG(*) AS Cnt FROM dbo.Sales GROUP BY Region';
const SALES_TRIGGER = 'CREATE TRIGGER dbo.trSales ON dbo.Sales AFTER INSERT AS RETURN';
const NOT_COMPARED = /one side is a snapshot saved before the engine read the indexes of views and database triggers/;

// A database with an indexed view, a database trigger and a trigger on a table.
function indexedViewSide() {
  return snapshot().database('Thai_CI_AS').table('Sales')
    .module('View', 'vTotals', 'V', 'VIEW', TOTALS_VIEW)
    .viewIndex('vTotals', 'CIX_vTotals', ['Region'], { clustered: true })
    .viewIndex('vTotals', 'IX_vTotals_Cnt', ['Cnt'])
    .databaseTrigger('trDdl', 'CREATE TRIGGER trDdl ON DATABASE FOR CREATE_SYNONYM AS SET NOCOUNT ON;')
    .trigger('trSales', 'Sales', SALES_TRIGGER);
}

// The same database without the view's indexes and the database trigger: as it is when it has
// none, or as a file of version 1 holds it whatever it has.
function plainViewSide(trigger = SALES_TRIGGER) {
  return snapshot().database('Thai_CI_AS').table('Sales')
    .module('View', 'vTotals', 'V', 'VIEW', TOTALS_VIEW)
    .trigger('trSales', 'Sales', trigger);
}

test('script: indexes of views and database triggers are compared when both sides read them', () => {
  const missing = scriptsFor('view-items-missing', indexedViewSide(), plainViewSide());
  assert.deepEqual(missing.statuses, {
    'dbo.vTotals.CIX_vTotals': 'OnlyInSource',
    'dbo.vTotals.IX_vTotals_Cnt': 'OnlyInSource',
    'trDdl (database trigger)': 'OnlyInSource',
  });
  assert.equal(missing.details['trDdl (database trigger)'], 'Type: SQL_TRIGGER; Table: DATABASE; State: ENABLED');
  assert.equal(missing.details['dbo.vTotals.CIX_vTotals'], 'Kind: UNIQUE INDEX; Type: CLUSTERED; Columns: Region');
  assert.doesNotMatch(missing.log, NOT_COMPARED);

  const extra = scriptsFor('view-items-extra', plainViewSide(), indexedViewSide());
  assert.deepEqual(extra.statuses, {
    'dbo.vTotals.CIX_vTotals': 'OnlyInTarget',
    'dbo.vTotals.IX_vTotals_Cnt': 'OnlyInTarget',
    'trDdl (database trigger)': 'OnlyInTarget',
  });

  // Changed ones: another column list, another event, disabled.
  const changedSide = plainViewSide()
    .viewIndex('vTotals', 'CIX_vTotals', ['Region'], { clustered: true })
    .viewIndex('vTotals', 'IX_vTotals_Cnt', ['Cnt', 'Region'])
    .databaseTrigger('trDdl', 'CREATE TRIGGER trDdl ON DATABASE FOR DROP_SYNONYM AS SET NOCOUNT ON;', 'DISABLED');
  const changed = scriptsFor('view-items-changed', indexedViewSide(), changedSide);
  assert.deepEqual(changed.statuses, { 'dbo.vTotals.IX_vTotals_Cnt': 'Different', 'trDdl (database trigger)': 'Different' });
  assert.equal(changed.details['dbo.vTotals.IX_vTotals_Cnt'], 'Columns: source Cnt, target Cnt, Region');
  assert.equal(changed.details['trDdl (database trigger)'], 'Definition differs\nState: source ENABLED, target DISABLED');

  // A view on one side only is one difference: its indexes come with it, as a table's do.
  const noView = snapshot().database('Thai_CI_AS').table('Sales').trigger('trSales', 'Sales', SALES_TRIGGER).databaseTrigger('trDdl', 'CREATE TRIGGER trDdl ON DATABASE FOR CREATE_SYNONYM AS SET NOCOUNT ON;');
  assert.deepEqual(scriptsFor('view-items-new-view', indexedViewSide(), noView).statuses, { 'dbo.vTotals': 'OnlyInSource' });
});

test('script: a snapshot saved before view indexes and database triggers were read does not show them as differences', () => {
  for (const [name, source, target] of [
    ['view-items-old-target', indexedViewSide(), plainViewSide().savedAsVersion(1)],
    ['view-items-old-source', plainViewSide().savedAsVersion(1), indexedViewSide()],
    ['view-items-old-both', plainViewSide().savedAsVersion(1), plainViewSide().savedAsVersion(1)],
  ] as const) {
    const s = scriptsFor(name, source, target);
    assert.deepEqual(s.statuses, {}, name);
    assert.equal(s.exitCode, 0, name);
    assert.match(s.log, NOT_COMPARED, name);
    assert.ok(!/vTotals|trDdl/.test(statements(s.sync).join('\n') + statements(s.rollback).join('\n')), name);
  }

  // Everything else is compared as before, a table's trigger among it.
  const other = 'CREATE TRIGGER dbo.trSales ON dbo.Sales AFTER UPDATE AS RETURN';
  const rest = scriptsFor('view-items-old-rest', indexedViewSide(), plainViewSide(other).savedAsVersion(1));
  assert.deepEqual(rest.statuses, { 'dbo.trSales': 'Different' });
  assert.match(rest.log, NOT_COMPARED);

  // Nothing to say when neither kind is among what is compared.
  const tables = scriptsFor('view-items-old-tables', indexedViewSide(), plainViewSide().savedAsVersion(1), { categories: 'Table,Column,View' });
  assert.deepEqual(tables.statuses, {});
  assert.doesNotMatch(tables.log, NOT_COMPARED);
});

// ---------------------------------------------------------------------------------------------
// Scripts for the indexes of views. ALTER VIEW drops every index of the view (and CREATE OR ALTER
// VIEW is an ALTER when the view is there), so a script that writes a view creates that view's
// indexes again. The indexes of the other views come in a section after the views.
// ---------------------------------------------------------------------------------------------

function totalsView(name: string, filter = ''): string {
  return `CREATE VIEW dbo.${name} WITH SCHEMABINDING AS SELECT Region, COUNT_BIG(*) AS Cnt FROM dbo.Sales ${filter}GROUP BY Region`;
}

function alteredTo(definition: string): string {
  return definition.replace('CREATE VIEW', 'CREATE OR ALTER VIEW');
}

test('script: a view the script writes gets its indexes again, and the other views theirs after the views', () => {
  const source = snapshot().database('Thai_CI_AS').table('Sales')
    // Another definition: altered, so everything on it has to be created again.
    .module('View', 'vAltered', 'V', 'VIEW', totalsView('vAltered', 'WHERE Region > 0 '))
    .viewIndex('vAltered', 'CIX_vAltered', ['Region'], { clustered: true })
    .viewIndex('vAltered', 'IX_vAltered_Cnt', ['Cnt'])
    // Only here.
    .module('View', 'vNew', 'V', 'VIEW', totalsView('vNew'))
    .viewIndex('vNew', 'CIX_vNew', ['Region'], { clustered: true })
    // The same view on both sides: both of its indexes are new (the nonclustered one sorts first).
    .module('View', 'vSame', 'V', 'VIEW', totalsView('vSame'))
    .viewIndex('vSame', 'AIX_vSame', ['Cnt'])
    .viewIndex('vSame', 'CIX_vSame', ['Region'], { clustered: true })
    // The same view, a nonclustered index with another column list.
    .module('View', 'vChanged', 'V', 'VIEW', totalsView('vChanged'))
    .viewIndex('vChanged', 'CIX_vChanged', ['Region'], { clustered: true })
    .viewIndex('vChanged', 'IX_vChanged', ['Cnt', 'Region'])
    // The same view, a clustered index with another column list.
    .module('View', 'vClustered', 'V', 'VIEW', totalsView('vClustered'))
    .viewIndex('vClustered', 'CIX_vClustered', ['Region', 'Cnt'], { clustered: true })
    .viewIndex('vClustered', 'IX_vClustered_Cnt', ['Cnt']);
  const target = snapshot().database('Thai_CI_AS').table('Sales')
    .module('View', 'vAltered', 'V', 'VIEW', totalsView('vAltered'))
    .viewIndex('vAltered', 'CIX_vAltered', ['Region'], { clustered: true })
    // Only here, on a view that gets altered: the ALTER drops it. (Other columns than the
    // source's index: with the same ones the two would be one index under two names.)
    .viewIndex('vAltered', 'IX_vAltered_Old', ['Cnt', 'Region'])
    .module('View', 'vSame', 'V', 'VIEW', totalsView('vSame'))
    .module('View', 'vChanged', 'V', 'VIEW', totalsView('vChanged'))
    .viewIndex('vChanged', 'CIX_vChanged', ['Region'], { clustered: true })
    .viewIndex('vChanged', 'IX_vChanged', ['Cnt'])
    // Only here, on a view that stays as it is: left, as an index of a table is.
    .viewIndex('vChanged', 'IX_vChanged_Old', ['Region'])
    .module('View', 'vClustered', 'V', 'VIEW', totalsView('vClustered'))
    .viewIndex('vClustered', 'CIX_vClustered', ['Region'], { clustered: true })
    .viewIndex('vClustered', 'IX_vClustered_Cnt', ['Cnt']);
  const s = scriptsFor('view-indexes', source, target);

  assert.deepEqual(statements(s.sync), [
    // The views, each with its indexes right after it, the clustered one first.
    alteredTo(totalsView('vNew')),
    'CREATE UNIQUE CLUSTERED INDEX [CIX_vNew] ON [dbo].[vNew] ([Region]);',
    alteredTo(totalsView('vAltered', 'WHERE Region > 0 ')),
    'CREATE UNIQUE CLUSTERED INDEX [CIX_vAltered] ON [dbo].[vAltered] ([Region]);',
    'CREATE NONCLUSTERED INDEX [IX_vAltered_Cnt] ON [dbo].[vAltered] ([Cnt]);',
    // Then the indexes of the views that were not written: new ones, the clustered one first.
    'CREATE UNIQUE CLUSTERED INDEX [CIX_vSame] ON [dbo].[vSame] ([Region]);',
    'CREATE NONCLUSTERED INDEX [AIX_vSame] ON [dbo].[vSame] ([Cnt]);',
    // A changed nonclustered one: dropped and created in one transaction, like a table's.
    ...inTransaction('DROP INDEX [IX_vChanged] ON [dbo].[vChanged];', 'CREATE NONCLUSTERED INDEX [IX_vChanged] ON [dbo].[vChanged] ([Cnt], [Region]);'),
    // Nothing for vClustered: dropping a clustered index takes the view's other indexes with it.
  ]);
  const said = comments(s.sync);
  assert.ok(said.includes('-- ALTER VIEW drops every index of a view. The indexes dbo.vAltered has in the source are created again:'), s.sync);
  assert.ok(said.includes('-- Not created again: index IX_vAltered_Old of dbo.vAltered is only in the target, and the ALTER VIEW above drops it. The rollback script creates it again.'), s.sync);
  // By hand, with the view's other index after it.
  const clustered = said.findIndex((l) => l.startsWith('-- The clustered index of a view differs.'));
  assert.deepEqual(said.slice(clustered + 1, clustered + 4), [
    '-- DROP INDEX [CIX_vClustered] ON [dbo].[vClustered];',
    '-- CREATE UNIQUE CLUSTERED INDEX [CIX_vClustered] ON [dbo].[vClustered] ([Region], [Cnt]);',
    '-- CREATE NONCLUSTERED INDEX [IX_vClustered_Cnt] ON [dbo].[vClustered] ([Cnt]);',
  ]);
  // Only in the target: the one on the view that stays is listed with the drops nobody runs; the
  // one on the altered view is gone already, and listing its drop would only mislead.
  assert.ok(said.includes('-- DROP INDEX [IX_vChanged_Old] ON [dbo].[vChanged];'), s.sync);
  assert.ok(!s.sync.includes('DROP INDEX [IX_vAltered_Old]'), s.sync);
  // The section of the views' indexes comes after the views.
  assert.ok(s.sync.indexOf('-- Indexes on views') > s.sync.indexOf('-- Views'), s.sync);

  assert.deepEqual(statements(s.rollback), [
    // What the sync script created.
    'DROP INDEX IF EXISTS [IX_vAltered_Cnt] ON [dbo].[vAltered];',
    'DROP INDEX IF EXISTS [AIX_vSame] ON [dbo].[vSame];',
    'DROP INDEX IF EXISTS [CIX_vSame] ON [dbo].[vSame];',
    'DROP VIEW IF EXISTS [dbo].[vNew];',
    // The view as it was, with the indexes it had: also the one the sync script lost.
    alteredTo(totalsView('vAltered')),
    'CREATE UNIQUE CLUSTERED INDEX [CIX_vAltered] ON [dbo].[vAltered] ([Region]);',
    'CREATE NONCLUSTERED INDEX [IX_vAltered_Old] ON [dbo].[vAltered] ([Cnt], [Region]);',
    ...inTransaction('DROP INDEX [IX_vChanged] ON [dbo].[vChanged];', 'CREATE NONCLUSTERED INDEX [IX_vChanged] ON [dbo].[vChanged] ([Cnt]);'),
  ]);
  assert.ok(comments(s.rollback).includes('-- ALTER VIEW drops every index of a view. The indexes dbo.vAltered had before the sync script are created again:'), s.rollback);
  assert.ok(comments(s.rollback).includes('-- CREATE UNIQUE CLUSTERED INDEX [CIX_vClustered] ON [dbo].[vClustered] ([Region]);'), s.rollback);

  // Indexes not among what is compared: a view the script writes still gets its own again (the
  // script is what drops them), and nothing else about indexes is written.
  const viewsOnly = scriptsFor('view-indexes-views-only', source, target, { categories: 'View' });
  assert.deepEqual(statements(viewsOnly.sync), [
    alteredTo(totalsView('vNew')),
    'CREATE UNIQUE CLUSTERED INDEX [CIX_vNew] ON [dbo].[vNew] ([Region]);',
    alteredTo(totalsView('vAltered', 'WHERE Region > 0 ')),
    'CREATE UNIQUE CLUSTERED INDEX [CIX_vAltered] ON [dbo].[vAltered] ([Region]);',
    'CREATE NONCLUSTERED INDEX [IX_vAltered_Cnt] ON [dbo].[vAltered] ([Cnt]);',
  ]);
  assert.ok(!viewsOnly.sync.includes('Indexes on views'), viewsOnly.sync);
});

test('script: a view taken from a snapshot without index details is altered with a warning about its indexes', () => {
  const source = snapshot().database('Thai_CI_AS').table('Sales')
    .module('View', 'vAltered', 'V', 'VIEW', totalsView('vAltered', 'WHERE Region > 0 '))
    .savedAsVersion(1);
  const target = snapshot().database('Thai_CI_AS').table('Sales')
    .module('View', 'vAltered', 'V', 'VIEW', totalsView('vAltered'))
    .viewIndex('vAltered', 'CIX_vAltered', ['Region'], { clustered: true })
    .viewIndex('vAltered', 'IX_vAltered_Cnt', ['Cnt']);
  const s = scriptsFor('view-indexes-old-model', source, target);

  // The view is still altered: that is the difference found. What indexes it had in the source
  // is not known, so none is created.
  assert.deepEqual(statements(s.sync), [alteredTo(totalsView('vAltered', 'WHERE Region > 0 '))]);
  const said = comments(s.sync);
  const warning = said.findIndex((l) => l.startsWith('-- WARNING: the ALTER VIEW above drops the indexes of dbo.vAltered (CIX_vAltered, IX_vAltered_Cnt), and this script cannot create them again'));
  assert.ok(warning >= 0, s.sync);
  assert.deepEqual(said.slice(warning + 1, warning + 3), [
    '-- CREATE UNIQUE CLUSTERED INDEX [CIX_vAltered] ON [dbo].[vAltered] ([Region]);',
    '-- CREATE NONCLUSTERED INDEX [IX_vAltered_Cnt] ON [dbo].[vAltered] ([Cnt]);',
  ]);

  // The rollback takes the view from the side that was read in full.
  assert.deepEqual(statements(s.rollback), [
    alteredTo(totalsView('vAltered')),
    'CREATE UNIQUE CLUSTERED INDEX [CIX_vAltered] ON [dbo].[vAltered] ([Region]);',
    'CREATE NONCLUSTERED INDEX [IX_vAltered_Cnt] ON [dbo].[vAltered] ([Cnt]);',
  ]);
});

test('script: on a target read without VIEW DEFINITION the indexes of a new view wait for its CREATE VIEW', () => {
  const source = snapshot().database('Thai_CI_AS').table('Sales')
    .module('View', 'vNew', 'V', 'VIEW', totalsView('vNew'))
    .viewIndex('vNew', 'CIX_vNew', ['Region'], { clustered: true })
    .viewIndex('vNew', 'IX_vNew_Cnt', ['Cnt']);
  const target = snapshot().database('Thai_CI_AS').table('Sales').readWithoutViewDefinition();
  const s = scriptsFor('view-indexes-guarded', source, target);

  // A plain CREATE, which fails when a view of that name is there but hidden from this login.
  assert.deepEqual(statements(s.sync), [totalsView('vNew')]);
  const guard = '-- Run this only if the CREATE VIEW of dbo.vNew above succeeded: ';
  assert.deepEqual(comments(s.sync).filter((l) => l.startsWith(guard)), [
    `${guard}CREATE UNIQUE CLUSTERED INDEX [CIX_vNew] ON [dbo].[vNew] ([Region]);`,
    `${guard}CREATE NONCLUSTERED INDEX [IX_vNew_Cnt] ON [dbo].[vNew] ([Cnt]);`,
  ]);
});

// ---------------------------------------------------------------------------------------------
// Scripts for database triggers. An enabled DDL trigger fires on the statements that come after
// it, and may refuse them. The sync script disables the ones it creates, changes or enables with
// its first statements (a run before this one may have left them enabled), writes them after
// everything else and enables them at its very end; the rollback script starts with them:
// disabled, then dropped or put back. It enables the ones that were enabled before the sync
// script with its last statements, when nothing is left for them to refuse. (With real triggers
// that refuse statements: test/engine-ddlguard.test.ts.)
// ---------------------------------------------------------------------------------------------

function ddlTrigger(name: string, events: string): string {
  return `CREATE TRIGGER ${name} ON DATABASE FOR ${events} AS SET NOCOUNT ON;`;
}

// DISABLE or ENABLE of a database trigger as the scripts write it: only when the trigger is there.
function triggerState(name: string, action: 'DISABLE' | 'ENABLE'): string {
  return `IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'${name}') ${action} TRIGGER [${name}] ON DATABASE;`;
}

// The first statements of a sync script: a database trigger it manages is disabled when it is
// there and enabled, and the run prints the statement that enables it again (with its database,
// found when it runs: see printed() further down).
const HELD = 'is disabled until the last statements of this script enable it again. If the script stops before them: run it again to its end, or run:';
const OFF = 'is disabled, as the source has it, and stays so. To have it enabled as it was, run:';
const NEW_HELD = 'is created, and disabled until the last statements of this script enable it. If the script stops before them: run it again to its end, or run:';
function disabledLoud(name: string, text: string): string {
  return `IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'${name}' AND is_disabled = 0) BEGIN DISABLE TRIGGER [${name}] ON DATABASE; ` +
    `PRINT N'database-diff: ' + QUOTENAME(DB_NAME()) + N': database trigger [${name}] ${text} USE ' + QUOTENAME(DB_NAME()) + N'; ENABLE TRIGGER [${name}] ON DATABASE;'; END`;
}

function databaseTriggerSides() {
  const source = snapshot().database('Thai_CI_AS').table('T')
    .databaseTrigger('trNew', ddlTrigger('trNew', 'CREATE_TABLE'))
    .databaseTrigger('trNewOff', ddlTrigger('trNewOff', 'CREATE_TABLE'), 'DISABLED')
    .databaseTrigger('trChanged', ddlTrigger('trChanged', 'CREATE_TABLE, DROP_TABLE'))
    .databaseTrigger('trOff', ddlTrigger('trOff', 'CREATE_TABLE'), 'DISABLED')
    .databaseTrigger('trOn', ddlTrigger('trOn', 'CREATE_TABLE'))
    .databaseTrigger('trAnsi', ddlTrigger('trAnsi', 'CREATE_TABLE'), 'ENABLED', 'ANSI_NULLS OFF')
    // A table's trigger of the same name as a database trigger: both can exist.
    .trigger('trNew', 'T', 'CREATE TRIGGER dbo.trNew ON dbo.T AFTER INSERT AS RETURN')
    .synonym('synNew', '[dbo].[T]');
  const target = snapshot().database('Thai_CI_AS').table('T')
    .databaseTrigger('trChanged', ddlTrigger('trChanged', 'CREATE_TABLE'))
    .databaseTrigger('trOff', ddlTrigger('trOff', 'CREATE_TABLE'))
    .databaseTrigger('trOn', ddlTrigger('trOn', 'CREATE_TABLE'), 'DISABLED')
    .databaseTrigger('trAnsi', ddlTrigger('trAnsi', 'CREATE_TABLE'))
    .databaseTrigger('trLegacy', ddlTrigger('trLegacy', 'DROP_TABLE'));
  return { source, target };
}

test('script: database triggers are written last and kept disabled until all are in place, and a rollback starts with them', () => {
  const { source, target } = databaseTriggerSides();
  const s = scriptsFor('database-triggers', source, target);
  const altered = (name: string, events: string) => ddlTrigger(name, events).replace('CREATE TRIGGER', 'CREATE OR ALTER TRIGGER');

  assert.deepEqual(statements(s.sync), [
    // Before anything else: every database trigger the script creates, changes or enables is
    // disabled. The new ones too: on a first run they are not there, on a second the first has
    // created and enabled them, and one of them may refuse what follows. And trOn, of which
    // only the state differs: the first run enabled it.
    // Each says so as it is disabled, with the statement that enables it again: a run that
    // stops before its end (an error under stop-on-error) leaves them disabled.
    disabledLoud('trNew', HELD),
    disabledLoud('trNewOff', OFF),
    disabledLoud('trAnsi', HELD),
    disabledLoud('trChanged', HELD),
    disabledLoud('trOff', OFF),
    disabledLoud('trOn', HELD),
    // The trigger of the table, with the triggers of tables. (A new trigger is enabled as well
    // as created: CREATE OR ALTER on one that is there and disabled would leave it disabled.)
    'CREATE OR ALTER TRIGGER dbo.trNew ON dbo.T AFTER INSERT AS RETURN',
    'ENABLE TRIGGER [dbo].[trNew] ON [dbo].[T];',
    'CREATE SYNONYM [dbo].[synNew] FOR [dbo].[T];',
    // Then the database triggers, last. The new ones: each disabled as soon as it is created
    // (CREATE makes it enabled), also the one the source has enabled.
    altered('trNew', 'CREATE_TABLE'),
    disabledLoud('trNew', NEW_HELD),
    altered('trNewOff', 'CREATE_TABLE'),
    triggerState('trNewOff', 'DISABLE'),
    // The changed ones, while they are disabled. Created under ANSI_NULLS OFF in the source: only
    // that differs.
    'SET ANSI_NULLS OFF;',
    altered('trAnsi', 'CREATE_TABLE'),
    'SET ANSI_NULLS ON;',
    'SET QUOTED_IDENTIFIER ON;',
    altered('trChanged', 'CREATE_TABLE, DROP_TABLE'),
    // And only now, with nothing left to create or change: enabled, the ones the source has
    // enabled. trOn among them, which differs in nothing else. Not trNewOff, not trOff.
    triggerState('trNew', 'ENABLE'),
    triggerState('trAnsi', 'ENABLE'),
    triggerState('trChanged', 'ENABLE'),
    triggerState('trOn', 'ENABLE'),
  ]);
  // Two sections of their own: the first of the script, and the one after the synonyms. The
  // target's own trigger is left, its drop a comment.
  const firstSection = s.sync.split('\n').find((l) => /^-- [A-Z]/.test(l) && s.sync.indexOf(l) > s.sync.indexOf('SET XACT_ABORT ON;'));
  assert.match(firstSection ?? '', /^-- Database triggers first: /, s.sync);
  assert.ok(s.sync.indexOf('-- Database triggers last') > s.sync.indexOf('-- Synonyms'), s.sync);
  assert.ok(s.sync.indexOf('-- Database triggers last') > s.sync.indexOf('-- Triggers'), s.sync);
  assert.ok(comments(s.sync).includes('-- DROP TRIGGER [trLegacy] ON DATABASE;'), s.sync);
  assert.ok(!statements(s.sync).some((l) => l.includes('trLegacy')), s.sync);

  assert.deepEqual(statements(s.rollback), [
    // Before anything else: the sync script left the source's triggers enabled, and one of them
    // may refuse every statement below. Disabled: the ones it created, the ones whose text it
    // changed, trOn, which it enabled, and trOff, which this script enables at its end (a second
    // run of this script meets it enabled).
    triggerState('trNew', 'DISABLE'),
    triggerState('trNewOff', 'DISABLE'),
    triggerState('trAnsi', 'DISABLE'),
    triggerState('trChanged', 'DISABLE'),
    triggerState('trOff', 'DISABLE'),
    triggerState('trOn', 'DISABLE'),
    // The created ones go.
    'DROP TRIGGER IF EXISTS [trNew] ON DATABASE;',
    'DROP TRIGGER IF EXISTS [trNewOff] ON DATABASE;',
    // The changed ones get the text they had.
    altered('trAnsi', 'CREATE_TABLE'),
    altered('trChanged', 'CREATE_TABLE'),
    // Then everything else, while they are all still disabled: one of them may be the target's
    // own guard, which would refuse these.
    'DROP TRIGGER IF EXISTS [dbo].[trNew];',
    'DROP SYNONYM IF EXISTS [dbo].[synNew];',
    // The last statements: enabled as before the sync script, trOff, which it disabled, among
    // them. Not trOn.
    triggerState('trAnsi', 'ENABLE'),
    triggerState('trChanged', 'ENABLE'),
    triggerState('trOff', 'ENABLE'),
  ]);
  assert.ok(s.rollback.indexOf('-- Database triggers first') > 0, s.rollback);
  assert.ok(s.rollback.indexOf('-- Database triggers first') < s.rollback.indexOf('-- Created by the sync script: dropped'), s.rollback);
  assert.ok(s.rollback.indexOf('-- Database triggers, enabled again') > s.rollback.indexOf('-- Created by the sync script: dropped'), s.rollback);
  assert.ok(!s.rollback.includes('trLegacy'), s.rollback);
});

test('script: a rollback enables database triggers after everything else, its commented-out drops included', () => {
  // The target's own guard, enabled on both sides with another text, and a table and a view the
  // sync script creates: the rollback drops the view, and leaves the drop of the table as a
  // comment for a person to uncomment.
  const side = (events: string) => snapshot().database('Thai_CI_AS').table('T').databaseTrigger('trGuard', ddlTrigger('trGuard', events));
  const source = side('DROP_TABLE, DROP_VIEW').table('Added').column('Added', 'Id', {})
    .module('View', 'vAdded', 'V', 'VIEW', 'CREATE VIEW dbo.vAdded AS SELECT 1 AS One');
  const s = scriptsFor('database-triggers-rollback-order', source, side('DROP_TABLE'));
  assert.deepEqual(statements(s.rollback), [
    triggerState('trGuard', 'DISABLE'),
    ddlTrigger('trGuard', 'DROP_TABLE').replace('CREATE TRIGGER', 'CREATE OR ALTER TRIGGER'),
    'DROP VIEW IF EXISTS [dbo].[vAdded];',
    triggerState('trGuard', 'ENABLE'),
  ]);
  const lines = s.rollback.split('\n');
  const enable = lines.indexOf(triggerState('trGuard', 'ENABLE'));
  // After the drop that is left as a comment: uncommented, it runs while the guard is disabled.
  assert.ok(enable > lines.indexOf('-- DROP TABLE [dbo].[Added];') && lines.indexOf('-- DROP TABLE [dbo].[Added];') > 0, s.rollback);
  // And nothing but the end of the script follows it.
  assert.deepEqual(lines.slice(enable + 1).filter((l) => l.trim()), ['GO', '-- End of script: ends the NOEXEC that a failed database check at the top turned on.', 'SET NOEXEC OFF;', 'GO'], s.rollback);
  // The sync script: the guard is disabled by its first statement, enabled by its last.
  assert.equal(statements(s.sync)[0], disabledLoud('trGuard', HELD));
  assert.equal(statements(s.sync).at(-1), triggerState('trGuard', 'ENABLE'));
});

test('script: a database trigger of which only the state differs is disabled first and enabled last, whichever way it differs', () => {
  // Only a state differs, each way, and one new trigger that the source has disabled.
  const side = (off: string, on: string) => snapshot().database('Thai_CI_AS').table('T')
    .databaseTrigger('trOff', ddlTrigger('trOff', 'CREATE_TABLE'), off)
    .databaseTrigger('trOn', ddlTrigger('trOn', 'CREATE_TABLE'), on)
    .databaseTrigger("tr'odd]name", "CREATE TRIGGER [tr'odd]]name] ON DATABASE FOR CREATE_TABLE AS SET NOCOUNT ON;");
  const source = side('DISABLED', 'ENABLED').databaseTrigger('trNewOff', ddlTrigger('trNewOff', 'CREATE_TABLE'), 'DISABLED');
  const s = scriptsFor('database-triggers-state', source, side('ENABLED', 'DISABLED'));
  assert.deepEqual(statements(s.sync), [
    // First: the new one (not there at a first run), the one to disable, and the one to enable:
    // a first run finds trOn disabled, a second run finds it enabled by the first.
    disabledLoud('trNewOff', OFF),
    disabledLoud('trOff', OFF),
    disabledLoud('trOn', HELD),
    // Last.
    ddlTrigger('trNewOff', 'CREATE_TABLE').replace('CREATE TRIGGER', 'CREATE OR ALTER TRIGGER'),
    triggerState('trNewOff', 'DISABLE'),
    triggerState('trOn', 'ENABLE'),
  ]);
  assert.deepEqual(statements(s.rollback), [
    // First, trOff as well: this script enables it at its end, and may be run again.
    triggerState('trNewOff', 'DISABLE'),
    triggerState('trOff', 'DISABLE'),
    triggerState('trOn', 'DISABLE'),
    'DROP TRIGGER IF EXISTS [trNewOff] ON DATABASE;',
    triggerState('trOff', 'ENABLE'),
  ]);
  // The line of a trigger of which only the state differs says where its statements are.
  assert.ok(comments(s.sync).includes('-- Enabled at the end of this section.'), s.sync);
  assert.ok(comments(s.sync).includes('-- Disabled by the first statements of this script.'), s.sync);
  assert.ok(comments(s.rollback).includes('-- Enabled by the last statements of this script.'), s.rollback);
  assert.ok(comments(s.rollback).includes('-- Disabled at the start of this section.'), s.rollback);

  // A name is written as a literal in the check and in brackets in the statement.
  const odd = scriptsFor('database-triggers-name', side('ENABLED', 'ENABLED'),
    snapshot().database('Thai_CI_AS').table('T')
      .databaseTrigger('trOff', ddlTrigger('trOff', 'CREATE_TABLE'))
      .databaseTrigger('trOn', ddlTrigger('trOn', 'CREATE_TABLE'))
      .databaseTrigger("tr'odd]name", "CREATE TRIGGER [tr'odd]]name] ON DATABASE FOR DROP_TABLE AS SET NOCOUNT ON;"));
  const first = statements(odd.sync)[0];
  assert.ok(first?.startsWith("IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'tr''odd]name' AND is_disabled = 0) BEGIN DISABLE TRIGGER [tr'odd]]name] ON DATABASE; PRINT N'database-diff: ' + QUOTENAME(DB_NAME()) + N': database trigger [tr''odd]]name] is disabled until "), first);
  assert.ok(first?.endsWith(" run: USE ' + QUOTENAME(DB_NAME()) + N'; ENABLE TRIGGER [tr''odd]]name] ON DATABASE;'; END"), first);
  assert.equal(statements(odd.sync).at(-1), "IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'tr''odd]name') ENABLE TRIGGER [tr'odd]]name] ON DATABASE;");
});

// On a target read without VIEW DEFINITION the scripts keep notes in a temporary table of the
// session that runs them (see $CreatedTriggersTable in lib/SyncScript.ps1). As they write them:
const CREATED = '#database_diff_created';
const DISABLED = '#database_diff_disabled';

function noteTable(table: string): string {
  return `IF OBJECT_ID(N'tempdb..${table}') IS NULL CREATE TABLE ${table} (database_id int NOT NULL, name nvarchar(128) COLLATE Latin1_General_BIN2 NOT NULL);`;
}

function dropNoteTable(table: string): string {
  return `IF OBJECT_ID(N'tempdb..${table}') IS NOT NULL DROP TABLE ${table};`;
}

// Before a CREATE: the trigger is noted when it is not there.
function noteMissing(name: string): string {
  return `IF NOT EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'${name}') INSERT INTO ${CREATED} (database_id, name) VALUES (DB_ID(), N'${name}');`;
}

// DISABLE or ENABLE only for a trigger that is noted in table.
function notedState(name: string, table: string, action: 'DISABLE' | 'ENABLE'): string {
  return `IF EXISTS (SELECT 1 FROM ${table} WHERE database_id = DB_ID() AND name = N'${name}') AND EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'${name}') ${action} TRIGGER [${name}] ON DATABASE;`;
}

// What a script prints about a database trigger: the database it runs in (found when it runs: a
// combined script has many, and their triggers share names), the text, and the statement to
// run, which names that database too (a new query window is in another one).
function printed(name: string, text: string): string {
  return `PRINT N'database-diff: ' + QUOTENAME(DB_NAME()) + N': ${text} USE ' + QUOTENAME(DB_NAME()) + N'; ENABLE TRIGGER [${name}] ON DATABASE;';`;
}

// A trigger that is enabled is noted and disabled, and the run says how to enable it again
// should the script stop before it does so itself.
function disableAndNote(name: string): string {
  return `IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'${name}' AND is_disabled = 0) BEGIN INSERT INTO ${DISABLED} (database_id, name) VALUES (DB_ID(), N'${name}'); DISABLE TRIGGER [${name}] ON DATABASE; ` +
    `${printed(name, `database trigger [${name}] is disabled while this script runs; its last statements enable it again. If the script stops before them, run:`)} END`;
}

// A trigger this run of the sync script created (it is noted) is disabled, and the run says how
// to enable it should the script stop before its last statements.
function disableCreated(name: string): string {
  return `IF EXISTS (SELECT 1 FROM ${CREATED} WHERE database_id = DB_ID() AND name = N'${name}') AND EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'${name}') BEGIN DISABLE TRIGGER [${name}] ON DATABASE; ` +
    `${printed(name, `database trigger [${name}] is created, and disabled until the last statements of this script enable it. If the script stops before them: run it again to its end, then run:`)} END`;
}

// At the end of a script: a trigger that is disabled and not noted in table gets a warning. One
// wording per script, the same for every trigger: why it is disabled, the script cannot know.
function warnDisabled(name: string, table: string): string {
  const text = table === CREATED
    ? `WARNING: database trigger [${name}] is disabled, and this run did not create it: it was there before this run. It may have been disabled all along. If an earlier run of this script stopped part way, the lines that run printed list what it created: only if this trigger is among them, run:`
    : `WARNING: database trigger [${name}] is disabled, and this run did not disable it. It may have been disabled all along. If an earlier run of this script stopped part way, the lines that run printed list what it disabled: only if this trigger is among them, run:`;
  return `IF EXISTS (SELECT 1 FROM sys.triggers WHERE parent_class = 0 AND name = N'${name}' AND is_disabled = 1) AND NOT EXISTS (SELECT 1 FROM ${table} WHERE database_id = DB_ID() AND name = N'${name}') ${printed(name, text)}`;
}

test('script: the statement a script prints to enable a database trigger is right for any name', () => {
  // A quote ends a literal and a bracket a name: both are doubled where they must be, so that
  // what is printed is the statement as it has to be run.
  const odd = "tr'odd]name";
  const source = snapshot().database('Thai_CI_AS').table('T').databaseTrigger(odd, "CREATE TRIGGER [tr'odd]]name] ON DATABASE FOR CREATE_TABLE AS SET NOCOUNT ON;");
  const s = scriptsFor('database-triggers-incomplete-name', source, snapshot().database('Thai_CI_AS').table('T').readWithoutViewDefinition());
  const toRun = " run: USE ' + QUOTENAME(DB_NAME()) + N'; ENABLE TRIGGER [tr''odd]]name] ON DATABASE;';";
  assert.equal(statements(s.sync).filter((l) => l.includes(toRun)).length, 2, s.sync);
  assert.equal(statements(s.rollback).filter((l) => l.includes(toRun)).length, 2, s.rollback);
  const prints = [...statements(s.sync), ...statements(s.rollback)].filter((l) => l.includes('PRINT '));
  assert.equal(prints.length, 4);
  for (const line of prints) {
    // The database is not written into the script: it is the one the statement runs in.
    assert.match(line, /PRINT N'database-diff: ' \+ QUOTENAME\(DB_NAME\(\)\) \+ N': (?:WARNING: )?database trigger \[tr''odd\]\]name\] is /, line);
    assert.ok(line.includes(toRun), line);
    assert.ok(!line.includes('target_db') && !line.includes('source_db'), line);
  }
});

test('script: on a target read without VIEW DEFINITION a new database trigger is a plain CREATE, disabled and enabled only when this run created it', () => {
  const { source, target } = databaseTriggerSides();
  const s = scriptsFor('database-triggers-incomplete', source, target.readWithoutViewDefinition());
  const altered = (name: string, events: string) => ddlTrigger(name, events).replace('CREATE TRIGGER', 'CREATE OR ALTER TRIGGER');
  const lines = statements(s.sync);
  // A login without VIEW DEFINITION sees no database trigger at all: the one "only in the source"
  // may be there. Plain CREATE fails then, instead of replacing it. And whether that one is
  // enabled is not this script's to change: before the CREATE the script notes whether the
  // trigger was missing, and it disables (an enabled one fires on the statements after it) and
  // enables only a trigger that is noted.
  // The ones both sides have are disabled by the first statements, as on any target: they are
  // the target's, and were compared. Not the new ones: one of those may be a trigger that was
  // there all along, and is touched only with a note of this run.
  assert.deepEqual(lines.slice(0, 4), [
    disabledLoud('trAnsi', HELD),
    disabledLoud('trChanged', HELD),
    disabledLoud('trOff', OFF),
    disabledLoud('trOn', HELD),
  ]);
  assert.deepEqual(lines.slice(lines.indexOf(noteTable(CREATED))), [
    noteTable(CREATED),
    noteMissing('trNew'),
    ddlTrigger('trNew', 'CREATE_TABLE'),
    // With the statement that enables it, printed for the case that the script stops before
    // its end. Not for trNewOff, which stays disabled.
    disableCreated('trNew'),
    noteMissing('trNewOff'),
    ddlTrigger('trNewOff', 'CREATE_TABLE'),
    notedState('trNewOff', CREATED, 'DISABLE'),
    'SET ANSI_NULLS OFF;',
    altered('trAnsi', 'CREATE_TABLE'),
    'SET ANSI_NULLS ON;',
    'SET QUOTED_IDENTIFIER ON;',
    altered('trChanged', 'CREATE_TABLE, DROP_TABLE'),
    // Enabled at the end: trNew when this run created it. Not trNewOff, which the source has
    // disabled.
    notedState('trNew', CREATED, 'ENABLE'),
    // Disabled, and not created by this run: a run before this one may have created it and
    // stopped. Said, not guessed at.
    warnDisabled('trNew', CREATED),
    triggerState('trAnsi', 'ENABLE'),
    triggerState('trChanged', 'ENABLE'),
    triggerState('trOn', 'ENABLE'),
    dropNoteTable(CREATED),
  ]);
  assert.ok(lines.indexOf(noteTable(CREATED)) > 0, s.sync);
  // Nothing touches a new trigger without looking at the notes first.
  for (const script of [s.sync, s.rollback]) {
    for (const line of statements(script).filter((l) => /(?:DISABLE|ENABLE) TRIGGER \[trNew(?:Off)?\]/.test(l))) assert.match(line, /#database_diff_(?:created|disabled)/, script);
  }
  assert.ok(!comments(s.sync).some((l) => l.includes('It is disabled in source') && l.includes('ON DATABASE')), s.sync);

  // The rollback cannot know which of the two the sync script created. It does not drop them:
  // the enabled ones are disabled while it runs, noted, and enabled again by its last statements.
  assert.deepEqual(statements(s.rollback), [
    noteTable(DISABLED),
    disableAndNote('trNew'),
    disableAndNote('trNewOff'),
    triggerState('trAnsi', 'DISABLE'),
    triggerState('trChanged', 'DISABLE'),
    triggerState('trOff', 'DISABLE'),
    triggerState('trOn', 'DISABLE'),
    altered('trAnsi', 'CREATE_TABLE'),
    altered('trChanged', 'CREATE_TABLE'),
    triggerState('trAnsi', 'ENABLE'),
    triggerState('trChanged', 'ENABLE'),
    triggerState('trOff', 'ENABLE'),
    notedState('trNew', DISABLED, 'ENABLE'),
    // Disabled, and not by this run: a warning, in the same words for the one the source has
    // enabled and the one it has disabled (what the source has says nothing of a trigger that
    // may have been in the target all along).
    warnDisabled('trNew', DISABLED),
    notedState('trNewOff', DISABLED, 'ENABLE'),
    warnDisabled('trNewOff', DISABLED),
    dropNoteTable(DISABLED),
  ]);
  const rollback = s.rollback.split('\n');
  const drop = rollback.indexOf('-- DROP TRIGGER IF EXISTS [trNew] ON DATABASE;');
  // The drop is a comment, between the statement that disables the trigger and the one that
  // enables it again: uncommented, it is not refused by the trigger itself.
  assert.ok(drop > rollback.indexOf(disableAndNote('trNew')) && drop < rollback.indexOf(notedState('trNew', DISABLED, 'ENABLE')), s.rollback);
  assert.ok(comments(s.rollback).some((l) => l.includes('the drop of a database trigger meets it disabled')), s.rollback);

  // Both headers say so, in lines as long as the others.
  assert.match(header(s.sync), /A database trigger that is only in the source is disabled and enabled by this script only when this run created it: .*#database_diff_created.*One that was there already, hidden from the comparison, is left as it is, enabled or not/);
  assert.match(header(s.rollback), /Nor can this script tell which database triggers the sync script created\. .*disabled first .*#database_diff_disabled.*enabled again by the last statements, after the commented-out drops\. That also happens to one that was there before the sync script: it ends as it started/);
  // A script that stops part way leaves triggers disabled, and its notes do not outlive the
  // session. Both headers say what to do then; the sync script also how not to get there (an
  // object that is there already is an error it expects, and stop-on-error stops at the first).
  assert.match(header(s.sync), /Msg 2714 is therefore expected on this target\. Do not run this script with stop-on-error \(sqlcmd -b\): it would stop at the first one, and leave the database triggers it created or was changing disabled\./);
  assert.match(header(s.sync), /For each trigger it disables, the script prints the statement that enables it again \(USE \.\.\.; ENABLE TRIGGER \.\.\. ON DATABASE\)\. If it did stop part way: run it again to its end, then run those statements for the triggers it created \(a changed one is enabled by that run itself\)\./);
  assert.match(header(s.sync), /Only a run in the same session \(query window\) still has the notes and enables them itself; in another session the script prints a warning for each of them it finds disabled, also for one that was disabled all along: enable only what the stopped run said it created\./);
  assert.match(header(s.rollback), /If this script stops part way, those triggers stay disabled, the target's own among them, and the notes are gone with the session\. For each trigger it disables, the script prints the statement that enables it again \(USE \.\.\.; ENABLE TRIGGER \.\.\. ON DATABASE\)\. Then: run the script again to its end, and run those statements\./);
  assert.match(header(s.rollback), /in another session the script cannot know what the stopped run disabled\. It prints a warning for each trigger it finds disabled, also for one that was disabled all along: enable only what the stopped run listed\./);
  // On such a target the sync script does not say that it can simply be run again: the new
  // triggers a run before it created are not disabled by its first statements.
  assert.match(header(s.sync), /Database triggers \(ON DATABASE\): the ones this script changes or enables are disabled by its first statements, and changed and enabled by its last: .*The new ones are created by the last statements too; for those, and for running this script again, see INCOMPLETE COMPARISON below\./);
  assert.doesNotMatch(header(s.sync), /can be run again after a run of it/);
  assert.match(header(s.sync), /Until then they are disabled for every session, not only this one: a trigger among them that records DDL \(an audit trigger\) records nothing while this script runs\./);
  // "Run it again, or its last section" is right only where the script itself knows what to
  // enable: on a target read in full.
  assert.doesNotMatch(header(s.rollback), /run it again, or its last section/);
  assert.match(header(s.rollback), /If the script stops part way they stay disabled: see the INCOMPLETE COMPARISON lines below for what to do then\./);
  for (const script of [s.sync, s.rollback]) {
    for (const line of headerLines(script).slice(3).filter((l) => !l.startsWith('-- WARNING: '))) assert.ok(line.length <= 100, line);
  }

  // A target read in full has no notes: nothing in its scripts names the temporary tables,
  // and nothing is printed. Its rollback knows what to enable, in any session.
  const complete = scriptsFor('database-triggers', databaseTriggerSides().source, databaseTriggerSides().target);
  assert.doesNotMatch(complete.sync + complete.rollback, /#database_diff_/);
  // What its sync script prints is what it disables with its first statements, and each new
  // trigger after its CREATE: never a warning.
  assert.doesNotMatch(complete.sync, /WARNING/);
  assert.doesNotMatch(complete.rollback, /PRINT /);
  assert.match(header(complete.rollback), /If the script stops part way they stay disabled: run it again, or its last section\./);
});

// ---------------------------------------------------------------------------------------------
// The header of a script: what its reader is told before the first statement.
// ---------------------------------------------------------------------------------------------

// The comment lines above the USE of a script, as one text.
function headerLines(script: string): string[] {
  const lines = script.split('\n').map((l) => l.trimEnd());
  const use = lines.findIndex((l) => l.startsWith('USE ['));
  assert.ok(use > 0, script);
  return lines.slice(0, use);
}

function header(script: string): string {
  return headerLines(script).map((l) => l.replace(/^--\s?/, '').trim()).join(' ');
}

test('script: the header says what is left to do by hand and in which order things come', () => {
  const side = snapshot().database('Thai_CI_AS').table('T').column('T', 'Id', {});
  const s = scriptsFor('header', side, snapshot().database('Thai_CI_AS').table('T').column('T', 'Id', { Type: 'bigint' }));
  for (const [name, script] of [['sync', s.sync], ['rollback', s.rollback]] as const) {
    const text = header(script);
    // ALTER COLUMN is active, but not for a column that a computed column uses: that change is a
    // commented group to run by hand.
    assert.match(text, /ALTER COLUMN statements are active/, name);
    assert.match(text, /column that a computed column uses.*Msg 5074.*comment.*by hand/, name);
    // A view the script alters gets its indexes again; those of the other views come after the views.
    assert.match(text, /ALTER VIEW drops every index of a view/, name);
    // The bullets are wrapped like the rest of the header (the three lines with the labels and
    // the date are as long as the labels make them).
    for (const line of headerLines(script).slice(3)) assert.ok(line.length <= 100, `${name}: ${line}`);
  }
  // Database triggers: a sync script disables the ones it creates, changes or enables with its
  // first statements and writes them last, so it can be run again; a rollback script starts
  // with them, disables them before it drops or changes anything and enables them again with
  // its last statements.
  assert.match(header(s.sync), /Database triggers \(ON DATABASE\): the ones this script creates, changes or enables are disabled by its first statements, and created, changed and enabled by its last: an enabled one fires on the statements after it and may refuse them\./);
  // A second run is not silent: what the first created is there, and CREATE says so.
  assert.match(header(s.sync), /So the script can be run again after a run of it that completed or stopped part way: what that run enabled is disabled first, and what it created is reported as there already \(Msg 2714, Msg 1913 and the like\)\./);
  // Not with stop-on-error: that ends the run at the first such message, after the triggers were
  // disabled. What the script prints then, and what to do.
  assert.match(header(s.sync), /Do not run it with stop-on-error \(sqlcmd -b\): it would stop at the first such message, or at any other error, with those triggers disabled\. For each trigger it disables, the script prints the statement that enables it again \(USE \.\.\.; ENABLE TRIGGER \.\.\. ON DATABASE\)\. If it stopped part way: run it again to its end, or run those statements to have the triggers enabled again\./);
  // Disabled means for everyone: what that is for a trigger that records DDL.
  assert.match(header(s.sync), /Until then they are disabled for every session, not only this one: a trigger among them that records DDL \(an audit trigger\) records nothing while this script runs\./);
  assert.match(header(s.sync), /A database trigger this script does not touch stays enabled: if it refuses DDL, disable it by hand before running this script\./);
  assert.match(header(s.rollback), /Database triggers \(ON DATABASE\) come first: .*disabled, then dropped or put back\. .*enabled before the sync script are enabled again by the last statements of this file/);
  assert.match(header(s.rollback), /If the script stops part way they stay disabled: run it again/);
  assert.doesNotMatch(header(s.rollback), /come last/);
});
