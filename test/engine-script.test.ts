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

  assert.deepEqual(statements(s.sync), [
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Both] ADD PERSISTED;',
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Qty] bigint NOT NULL;',
  ]);
  // What to run by hand for NOT NULL, as comments.
  for (const line of [
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Twice];',
    '-- ALTER TABLE [dbo].[T] ADD [Twice] AS ([Qty]*(2)) PERSISTED NOT NULL;',
    '-- ALTER TABLE [dbo].[T] DROP COLUMN [Both];',
    '-- ALTER TABLE [dbo].[T] ADD [Both] AS ([Qty]*(2)) PERSISTED NOT NULL;',
  ]) assert.ok(comments(s.sync).includes(line), `${line} expected in:\n${s.sync}`);
  // The type of Half is not something to run: it changes with Qty.
  assert.ok(!s.sync.includes('DROP COLUMN [Half]'), s.sync);
  assert.equal(comments(s.sync).filter((l) => /^-- Not scripted: .*computed column/.test(l)).length, 3, s.sync);

  assert.deepEqual(statements(s.rollback), [
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Both] DROP PERSISTED;',
    'ALTER TABLE [dbo].[T] ALTER COLUMN [Qty] int NOT NULL;',
  ]);
  assert.ok(comments(s.rollback).includes('-- ALTER TABLE [dbo].[T] ADD [Twice] AS ([Qty]*(2)) PERSISTED;'), s.rollback);
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
