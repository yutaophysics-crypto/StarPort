import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// A wrapper for another checkout or port must never open that checkout's data.
export function findMacApp(root, { port = 3210, dataDir = process.env.HARNESS_HUB_DATA || join(root, '.data'), candidates = [
  '/Applications/StarPort.app', join(homedir(), 'Applications', 'StarPort.app'),
  join(root, '.runtime', 'macos', 'StarPort.app'),
  // Keep existing localized installations usable without moving their data.
  '/Applications/星港.app', join(homedir(), 'Applications', '星港.app'),
  join(root, '.runtime', 'macos', '星港.app')
] } = {}) {
  for (const app of candidates) {
    try {
      const config = JSON.parse(readFileSync(join(app, 'Contents/Resources/starport-config.json'), 'utf8'));
      if (typeof config.root === 'string' && resolve(config.root) === resolve(root)
          && config.port === port && resolve(config.environment?.HARNESS_HUB_DATA || join(config.root, '.data')) === resolve(dataDir)
          && existsSync(join(app, 'Contents/MacOS/StarPort'))) return app;
    } catch { /* Missing or obsolete wrapper: retain the browser fallback. */ }
  }
  return null;
}
