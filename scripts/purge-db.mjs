// Physically removes deleted-row residue from the Starport SQLite database.
// Steps: TRUNCATE-checkpoint the WAL (recent commits land in the main file),
// then VACUUM (rebuilds the file, dropping free pages that still hold old text).
// Run only while the Starport server is stopped.
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/purge-db.mjs <path-to-hub.sqlite>');
  process.exit(2);
}

const bytes = (p) => { try { return statSync(p).size; } catch { return -1; } };
const before = bytes(file);
const beforeWal = bytes(file + '-wal');

const db = new DatabaseSync(file);
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.exec('VACUUM;');
} finally {
  db.close();
}

const after = bytes(file);
const afterWal = bytes(file + '-wal');
console.log(`main before/after: ${before} -> ${after} bytes`);
console.log(`wal  before/after: ${beforeWal} -> ${afterWal} bytes`);
console.log('purge ok');
