import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLocalServices, localServicesEnvironment } from '../scripts/local-services.mjs';

test('a machine profile selects a shared HTTPS service without exposing a personal server', t => {
  const data = mkdtempSync(join(tmpdir(), 'starport-services-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  assert.equal(readLocalServices(data, data), null);
  const write = config => writeFileSync(join(data, 'local-services.json'), JSON.stringify(config));
  write({ collaborationUrl: 'https://groups.example.com/' });
  assert.deepEqual(localServicesEnvironment(readLocalServices(data, data), {}), { STARPORT_COLLAB_URL: 'https://groups.example.com' });
  write({ collaborationUrl: 'https://groups.example.com', server: true, events: 'poll' });
  const config = readLocalServices(data, data);
  assert.deepEqual(localServicesEnvironment(config, {}), {
    STARPORT_COLLAB_URL: 'https://groups.example.com', STARPORT_PUBLIC_URL: 'https://groups.example.com', STARPORT_COLLAB_EVENTS: 'poll'
  });
  assert.throws(() => localServicesEnvironment(config, { STARPORT_PUBLIC_URL: 'https://another.example' }), /冲突/);
  for (const collaborationUrl of ['http://192.168.1.1:3218', 'https://user:password@groups.example.com', 'https://groups.example.com/path', 'https://groups.example.com/?invite=private']) {
    write({ collaborationUrl });
    assert.throws(() => readLocalServices(data, data), /HTTPS/);
  }
  write({ collaborationUrl: 'https://groups.example.com', server: 'false' });
  assert.throws(() => readLocalServices(data, data), /布尔/);
  write({ collaborationUrl: 'https://groups.example.com', events: 'unknown' });
  assert.throws(() => readLocalServices(data, data), /events/);
});
