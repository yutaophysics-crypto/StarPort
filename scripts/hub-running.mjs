// Prints the number of currently running turns (0 when the workspace is idle).
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const dbPath = process.argv[2] || join(process.cwd(), '.data', 'hub.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });
console.log(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE status='running'").get().c);
