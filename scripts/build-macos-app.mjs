import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findMacApp } from './macos-app.mjs';

const root = resolve(import.meta.dirname, '..'), options = {};
const accepted = new Set(['output', 'node', 'proxy-audit', 'python', 'port', 'collaboration-url']);
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index].replace(/^--/, '');
  if (!accepted.has(key) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw Error('Usage: node scripts/build-macos-app.mjs [--output app-path] [--node node-path] [--proxy-audit script] [--python python-path] [--port port] [--collaboration-url HTTPS-URL]');
  }
  options[key] = process.argv[++index];
}
if (process.platform !== 'darwin') throw Error('Build the native desktop app on macOS.');
const output = resolve(options.output || findMacApp(root) || join(homedir(), 'Applications', 'StarPort.app'));
if (!output.endsWith('.app')) throw Error('Output must be an .app bundle.');
let previous = {};
try { previous = JSON.parse(readFileSync(join(output, 'Contents/Resources/starport-config.json'), 'utf8')); } catch {}
const port = Number(options.port || previous.port || process.env.HARNESS_HUB_PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid server port.');
const environment = { ...previous.environment, HARNESS_HUB_PORT: String(port) };
for (const key of ['HARNESS_HUB_DATA', 'STARPORT_COLLAB_URL', 'STARPORT_COLLAB_PORT']) {
  if (process.env[key]) environment[key] = process.env[key];
}
if (options['collaboration-url']) environment.STARPORT_COLLAB_URL = options['collaboration-url'];
const config = { root, node: resolve(options.node || previous.node || process.execPath), port,
  python: options.python || previous.python || '/usr/bin/python3',
  proxyAudit: options['proxy-audit'] || previous.proxyAudit || null, environment };
if (!existsSync(config.node)) throw Error('Node runtime does not exist.');
if (config.proxyAudit && !existsSync(config.proxyAudit)) throw Error('Configured proxy audit does not exist.');
let identifier = 'app.starport.desktop';
if (existsSync(output)) {
  identifier = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(output, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (!['app.starport.desktop', 'local.tao.starport.launcher'].includes(identifier)) throw Error('Refusing to replace an unrelated application.');
}
const temporary = mkdtempSync(join(tmpdir(), 'starport-macos-build-'));
const staged = join(temporary, 'StarPort.app'), contents = join(staged, 'Contents');
const resources = join(contents, 'Resources'), binaries = join(contents, 'MacOS');
mkdirSync(resources, { recursive: true }); mkdirSync(binaries);
const icons = join(temporary, 'StarPort.iconset'); mkdirSync(icons);
for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
  const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
  execFileSync('sips', ['-z', String(size * scale), String(size * scale),
    join(root, 'public/mobile/icon-512.png'), '--out', join(icons, name)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', icons, '-o', join(resources, 'StarPort.icns')]);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const values = { CFBundleIdentifier: identifier, CFBundleName: 'StarPort', CFBundleDisplayName: 'StarPort',
  CFBundleExecutable: 'StarPort', CFBundleIconFile: 'StarPort.icns', CFBundlePackageType: 'APPL',
  CFBundleShortVersionString: '2.2', CFBundleVersion: '4', LSMinimumSystemVersion: '14.0',
  NSDocumentsFolderUsageDescription: 'StarPort needs access to local projects, chat data and startup checks in your Documents folder.' };
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(values).map(([key, value]) => `<key>${key}</key><string>${escape(value)}</string>`).join('')}<key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`;
writeFileSync(join(contents, 'Info.plist'), plist);
writeFileSync(join(resources, 'starport-config.json'), JSON.stringify(config, null, 2) + '\n');
execFileSync('xcrun', ['swiftc', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
  join(root, 'scripts/macos/StarPort.swift'), '-o', join(binaries, 'StarPort')], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', staged], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', staged]);
const backup = join(root, '.data/source-backups', 'macos-app-' + new Date().toISOString().replaceAll(':', '-'));
mkdirSync(dirname(output), { recursive: true });
if (existsSync(output)) {
  mkdirSync(backup, { recursive: true }); cpSync(output, join(backup, 'StarPort.app'), { recursive: true });
  rmSync(output, { recursive: true });
}
try { cpSync(staged, output, { recursive: true }); }
catch (error) {
  if (existsSync(output)) rmSync(output, { recursive: true });
  if (existsSync(join(backup, 'StarPort.app'))) cpSync(join(backup, 'StarPort.app'), output, { recursive: true });
  throw error;
}
const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
if (existsSync(register)) execFileSync(register, ['-f', output]);
rmSync(temporary, { recursive: true });
console.log(JSON.stringify({ app: output, previousAppBackup: existsSync(backup) ? backup : null, proxyAudit: !!config.proxyAudit }));
