// Engine test cases. Each one builds a source and a target database from test/fixtures/<fixture>
// (common.sql on both, then source.sql / target.sql) and keeps its output in test/golden/<name>.
export interface EngineCase {
  name: string;
  fixture: string;
  // Extra Compare-Database.ps1 switches.
  options: string[];
  // Also run the sync script on the target, then the rollback script, checking each step.
  roundTrip: boolean;
  // Value of -Categories. Default: All.
  categories?: string;
  // For a case that is not a round trip: run the sync script, then the rollback script, and keep
  // what is left to compare after each in the golden files. Its fixture has differences that no
  // script can make, so nothing is asserted about how many remain.
  apply?: boolean;
}

// What -Categories is when it is not given, and what the web app ticks by default.
const DEFAULT_CATEGORIES = 'Table,Column,View,StoredProcedure,Function';

export const CASES: EngineCase[] = [
  { name: 'core', fixture: 'core', options: [], roundTrip: true },
  { name: 'core-ignore-collation', fixture: 'core', options: ['-IgnoreCollation'], roundTrip: true },
  // Types, sequences and schemas are not compared here: the script still has to create the ones
  // that its new tables and columns need.
  { name: 'core-default', fixture: 'core', options: [], roundTrip: true, categories: DEFAULT_CATEGORIES },
  { name: 'edge', fixture: 'edge', options: [], roundTrip: false, apply: true },
  { name: 'edge-loose', fixture: 'edge', options: ['-IgnoreWhitespace', '-IgnoreCase', '-CompareColumnOrder'], roundTrip: false },
];
