// Engine test cases. Each one builds a source and a target database from test/fixtures/<fixture>
// (common.sql on both, then source.sql / target.sql) and keeps its output in test/golden/<name>.
export interface EngineCase {
  name: string;
  fixture: string;
  // Extra Compare-Database.ps1 switches.
  options: string[];
  // Also run the sync script on the target, then the rollback script, checking each step.
  roundTrip: boolean;
}

export const CASES: EngineCase[] = [
  { name: 'core', fixture: 'core', options: [], roundTrip: true },
  { name: 'core-ignore-collation', fixture: 'core', options: ['-IgnoreCollation'], roundTrip: true },
  { name: 'edge', fixture: 'edge', options: [], roundTrip: false },
  { name: 'edge-loose', fixture: 'edge', options: ['-IgnoreWhitespace', '-IgnoreCase', '-CompareColumnOrder'], roundTrip: false },
];
