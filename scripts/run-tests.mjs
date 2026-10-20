// Runs the test suite with its own temp folder, removed afterwards, so tests cannot leave
// starport-* folders behind in the system temp directory. A test that never settles fails
// after TEST_LIMIT with its name; a test file whose process does not exit (an open handle)
// is named and the run is stopped after FILE_LIMIT, instead of stalling CI until it is
// cancelled. (--test-force-exit is not used: on Windows it crashes Node at exit.)
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { finished } from 'node:stream/promises';

const TEST_LIMIT = 2 * 60_000, FILE_LIMIT = 5 * 60_000;
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'starport-test-run-')));
Object.assign(process.env, { TEMP: root, TMP: root, TMPDIR: root });

const files = process.argv.slice(2), controller = new AbortController(), running = new Map();
const stream = run({ ...(files.length ? { files } : { globPatterns: ['tests/*.test.mjs'] }), concurrency: true, timeout: TEST_LIMIT, signal: controller.signal });
const isFile = data => data.nesting === 0 && data.file && data.name === basename(data.file);
stream.on('test:dequeue', data => { if (isFile(data)) running.set(data.file, Date.now()); });
stream.on('test:complete', data => { if (isFile(data)) running.delete(data.file); });
stream.on('test:fail', () => { process.exitCode = 1; });
const watchdog = setInterval(() => {
  const stuck = [...running].filter(([, start]) => Date.now() - start > FILE_LIMIT).map(([file]) => relative(process.cwd(), file));
  if (!stuck.length) return;
  console.error(`\nStill running after ${FILE_LIMIT / 60_000} minutes, stopping the run: ${stuck.join(', ')}`);
  clearInterval(watchdog); process.exitCode = 1; controller.abort();
}, 5_000);

const report = stream.compose(spec);
report.pipe(process.stdout);
await finished(report);
clearInterval(watchdog);
try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
catch (error) { console.warn(`Could not remove test temp folder ${root}: ${error.message}`); }
