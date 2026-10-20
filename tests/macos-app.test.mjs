import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMacApp } from '../scripts/macos-app.mjs';

test('native launcher only reuses an app for this checkout and port', () => {
  const root = mkdtempSync(join(tmpdir(), 'starport-native-detection-'));
  const previousData = process.env.HARNESS_HUB_DATA;
  delete process.env.HARNESS_HUB_DATA;
  try {
    const app = join(root, '星港.app'), resources = join(app, 'Contents/Resources');
    mkdirSync(resources, { recursive: true }); mkdirSync(join(app, 'Contents/MacOS'));
    const file = join(resources, 'starport-config.json');
    writeFileSync(file, JSON.stringify({ root, port: 3210 }));
    assert.equal(findMacApp(root, { candidates: [app] }), null, 'unfinished bundle is not launchable');
    writeFileSync(join(app, 'Contents/MacOS/StarPort'), 'native binary');
    assert.equal(findMacApp(root, { candidates: [app] }), app);
    assert.equal(findMacApp(join(root, 'other'), { candidates: [app] }), null, 'another checkout must not expose its data');
    assert.equal(findMacApp(root, { port: 3211, candidates: [app] }), null);
    assert.equal(findMacApp(root, { dataDir: join(root, 'other-data'), candidates: [app] }), null);
    writeFileSync(file, JSON.stringify({ root, port: 3210, environment: { HARNESS_HUB_DATA: join(root, 'other-data') } }));
    assert.equal(findMacApp(root, { candidates: [app], dataDir: join(root, 'other-data') }), app);
    writeFileSync(file, '{broken');
    assert.equal(findMacApp(root, { candidates: [app] }), null);
  } finally {
    if (previousData === undefined) delete process.env.HARNESS_HUB_DATA;
    else process.env.HARNESS_HUB_DATA = previousData;
    rmSync(root, { recursive: true });
  }
});
