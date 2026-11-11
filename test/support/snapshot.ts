// Hand-made snapshot files: script details that two databases on one test server cannot show (two
// database collations, a base object in a database that is not there), without any database. The
// engine reads both sides from the files, as a drift comparison of two saved snapshots does.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT, compare } from './engine.js';

export interface SnapshotItem {
  Name: string;
  Props: Record<string, string>;
  Parent: string;
  Definition: string | null;
  ObjectName: string;
  Sql: Record<string, unknown> | null;
}

export type SnapshotCategories = Record<string, Record<string, SnapshotItem>>;

function item(name: string, props: Record<string, string>, sql: Record<string, unknown>, parent = '', definition: string | null = null): SnapshotItem {
  return { Name: name, Props: props, Parent: parent, Definition: definition, ObjectName: '', Sql: sql };
}

// Builds the categories of one side. Every method returns the builder.
export class SnapshotBuilder {
  readonly categories: SnapshotCategories = {};
  private ordinals = new Map<string, number>();

  private add(category: string, key: string, value: SnapshotItem): this {
    (this.categories[category] ??= {})[key] = value;
    return this;
  }

  database(collation: string): this {
    return this.add('Database', '(database)', item('(database)', { CompatibilityLevel: '140', Collation: collation }, {}));
  }

  table(name: string, schema = 'dbo'): this {
    return this.add('Table', `${schema}.${name}`, item(`${schema}.${name}`, {}, { Schema: schema, Name: name }));
  }

  // props: Type and whatever differs from a plain nullable column without a collation. A computed
  // column says Computed and Persisted. sql: DefaultName, when the default has a chosen name.
  column(table: string, name: string, props: Record<string, string>, sql: Record<string, unknown> = {}): this {
    const parent = `dbo.${table}`;
    const ordinal = (this.ordinals.get(parent) ?? 0) + 1;
    this.ordinals.set(parent, ordinal);
    const all: Record<string, string> = { Type: 'int', Nullable: 'NULL', Identity: '', Computed: '' };
    if (props['Computed']) all['Persisted'] = '';
    Object.assign(all, { Default: '', Collation: '', Ordinal: String(ordinal) }, props);
    return this.add('Column', `${parent}.${name}`, item(`${parent}.${name}`, all, { Schema: 'dbo', Table: table, Name: name, ...sql }, parent));
  }

  schema(name: string): this {
    return this.add('Schema', name, item(name, {}, { Schema: name }));
  }

  aliasType(name: string, spec: string, schema = 'dbo'): this {
    return this.add('User-defined type', `${schema}.${name}`, item(`${schema}.${name}`, { Kind: 'alias type', Spec: spec }, { Schema: schema, Name: name }));
  }

  // A table type. Without `read` it is as a snapshot from before 2026-11-11 has it: columns with
  // a name, a type and nullability, and no Details. With it: what the engine reads now.
  tableType(name: string, columns: Record<string, string>[], read?: { details: string; collation: string; keys?: unknown[]; checks?: string[] }): this {
    const spec = `(${columns.map((c) => `${c['Name']} ${c['Type']} ${c['Nullable']}`).join(', ')})`;
    const props: Record<string, string> = { Kind: 'table type', Spec: spec };
    const sql: Record<string, unknown> = { Schema: 'dbo', Name: name, Columns: columns };
    if (read) {
      Object.assign(props, { Details: read.details, Collation: read.collation });
      Object.assign(sql, { KeyConstraints: read.keys ?? [], Checks: read.checks ?? [] });
      sql['Columns'] = columns.map((c) => ({ Identity: '', Computed: '', Persisted: '', Default: '', Collation: '', ...c }));
    }
    return this.add('User-defined type', `dbo.${name}`, item(`dbo.${name}`, props, sql));
  }

  // props: what differs from a bigint sequence from 1 to 1000. A decimal or numeric one says
  // DataType and Precision (a snapshot from before 2026-11-11 has no Precision).
  sequence(name: string, schema = 'dbo', props: Record<string, string> = {}): this {
    const all: Record<string, string> = { DataType: props['DataType'] ?? 'bigint' };
    if (props['Precision']) all['Precision'] = props['Precision'];
    Object.assign(all, { Start: '1', Increment: '1', Min: '1', Max: '1000', Cycle: 'NO CYCLE', Cache: 'CACHE' }, props);
    return this.add('Sequence', `${schema}.${name}`, item(`${schema}.${name}`, all, { Schema: schema, Name: name }));
  }

  synonym(name: string, baseObject: string): this {
    return this.add('Synonym', `dbo.${name}`, item(`dbo.${name}`, { BaseObject: baseObject }, { Schema: 'dbo', Name: name }));
  }

  // A procedure, view or function. objectType: P, V, FN (scalar), IF (inline table-valued), ...
  module(category: 'Stored procedure' | 'View' | 'Function', name: string, objectType: string, typeDesc: string, definition: string, setOptions = ''): this {
    const sql = { Schema: 'dbo', Name: name, ObjectType: objectType, ParentSchema: '', ParentObject: '' };
    return this.add(category, `dbo.${name}`, item(`dbo.${name}`, { Type: typeDesc, SetOptions: setOptions }, sql, '', definition));
  }

  trigger(name: string, table: string, definition: string, state = 'ENABLED', setOptions = ''): this {
    const sql = { Schema: 'dbo', Name: name, ObjectType: 'TR', ParentSchema: 'dbo', ParentObject: table };
    const props = { Type: 'SQL_TRIGGER', Table: `dbo.${table}`, State: state, SetOptions: setOptions };
    return this.add('Trigger', `dbo.${name}`, item(`dbo.${name}`, props, sql, '', definition));
  }

  check(table: string, name: string, expression: string, state = 'ENABLED'): this {
    const value = item(`dbo.${table}.${name}`, { Expression: expression, State: state }, { Schema: 'dbo', Table: table, Name: name, IsSystemNamed: false }, `dbo.${table}`);
    value.ObjectName = name;
    return this.add('Check constraint', `dbo.${table}|${name}`, value);
  }

  // An index of a view (the view itself: module('View', ...)). The first index of a view is its
  // unique clustered one; nonclustered ones stand on it. A column is 'Name' or 'Name DESC'.
  viewIndex(view: string, name: string, columns: string[], options: { clustered?: boolean; unique?: boolean; include?: string[]; type?: string } = {}): this {
    const clustered = options.clustered ?? false;
    const unique = options.unique ?? clustered;
    const include = options.include ?? [];
    const type = options.type ?? '';
    const parent = `dbo.${view}`;
    const props = {
      Kind: unique ? 'UNIQUE INDEX' : 'INDEX', Type: type || (clustered ? 'CLUSTERED' : 'NONCLUSTERED'),
      Columns: columns.join(', '), Include: [...include].sort().join(', '), Filter: '',
    };
    const keyParts = columns.map((c) => ({ Name: c.replace(/ DESC$/, ''), Desc: c.endsWith(' DESC') }));
    const value = item(`${parent}.${name}`, props, { Schema: 'dbo', Table: view, Name: name, IsSystemNamed: false, KeyParts: keyParts, Includes: include }, parent);
    value.ObjectName = name;
    return this.add('Index', `${parent}|${name}`, value);
  }

  // A database trigger (CREATE TRIGGER ... ON DATABASE), as the engine keeps one: in the Trigger
  // category, without a schema, under a key of its own.
  databaseTrigger(name: string, definition: string, state = 'ENABLED', setOptions = ''): this {
    const sql = { Schema: '', Name: name, ObjectType: 'TR', ParentSchema: '', ParentObject: '', Scope: 'DATABASE' };
    const props = { Type: 'SQL_TRIGGER', Table: 'DATABASE', State: state, SetOptions: setOptions };
    return this.add('Trigger', `(database trigger)|${name}`, item(`${name} (database trigger)`, props, sql, '', definition));
  }

  // What the file says of itself. Version 1: saved before the engine read the indexes of views
  // and database triggers (a file like that holds none).
  version = 2;
  canViewDefinition = true;

  savedAsVersion(version: number): this {
    this.version = version;
    return this;
  }

  // Read by a login without VIEW DEFINITION.
  readWithoutViewDefinition(): this {
    this.canViewDefinition = false;
    return this;
  }
}

export function snapshot(): SnapshotBuilder {
  return new SnapshotBuilder();
}

export interface Scripts {
  sync: string;
  rollback: string;
  // Object -> Detail of the differences found.
  details: Record<string, string>;
  // Object -> Status (OnlyInSource, OnlyInTarget, Different, Unverified).
  statuses: Record<string, string>;
  exitCode: number | null;
  // What the engine printed.
  log: string;
}

// Compares two hand-made snapshots (source: the model, target: what the scripts change) and returns
// the scripts as text with \n line ends. `name` keeps the files of one test apart in test/.out/script.
export function scriptsFor(name: string, source: SnapshotBuilder, target: SnapshotBuilder, { options = [] as string[], categories = 'All' } = {}): Scripts {
  const dir = path.join(OUT, 'script');
  mkdirSync(dir, { recursive: true });
  const write = (side: string, builder: SnapshotBuilder): string => {
    const file = path.join(dir, `${name}.${side}.input.json`);
    writeFileSync(file, JSON.stringify({
      format: 'database-diff-snapshot', version: builder.version, captured: '2026-01-01T00:00:00', server: `${side}-server`, database: `${side}_db`,
      login: 'tester', canViewDefinition: builder.canViewDefinition, categories: builder.categories,
    }), 'utf8');
    return file;
  };
  const c = compare({ dir: 'script', name, sourceSnapshot: write('source', source), targetSnapshot: write('target', target), options, categories });
  if (c.result['syncError'] || c.result['rollbackError']) throw new Error(`script generation failed for ${name}:\n${c.log}`);
  const read = (file: string): string => readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const diffs = c.result['diffs'] as { Object: string; Detail: string; Status: string }[];
  return {
    sync: read(c.files.sync),
    rollback: read(c.files.rollback),
    details: Object.fromEntries(diffs.map((d) => [d.Object, d.Detail])),
    statuses: Object.fromEntries(diffs.map((d) => [d.Object, d.Status])),
    exitCode: c.exitCode,
    log: c.log,
  };
}

// The statements of a script: its lines without comments, blank lines, GO and the frame every
// script has (USE, the database check, the SET batch, SET NOEXEC OFF).
export function statements(script: string): string[] {
  const lines = script.split('\n').map((l) => l.trimEnd());
  const start = lines.indexOf('SET XACT_ABORT ON;');
  return lines.slice(start + 1).filter((l) => l && !l.startsWith('--') && l !== 'GO' && l !== 'SET NOEXEC OFF;');
}

// The comment lines of a script after its header.
export function comments(script: string): string[] {
  const lines = script.split('\n').map((l) => l.trimEnd());
  const start = lines.indexOf('SET XACT_ABORT ON;');
  return lines.slice(start + 1).filter((l) => l.startsWith('--') && !/^-- =+$/.test(l));
}
