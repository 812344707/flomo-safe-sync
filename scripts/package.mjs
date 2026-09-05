import { execFile } from 'child_process';
import { copyFile, mkdir, readFile, readdir, rm } from 'fs/promises';
import { promisify } from 'util';

const run = promisify(execFile);
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const target = `dist/${manifest.id}`;
const zipName = `${manifest.id}-${manifest.version}.zip`;
const zipPath = `dist/${zipName}`;

const runtimeFiles = ['main.js', 'manifest.json', 'styles.css'];
// Never reuse a previous package directory: it may contain a Vault's data.json
// or another stale file that must not be distributed during an upgrade.
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await Promise.all(
  runtimeFiles.map(file => copyFile(file, `${target}/${file}`)),
);
const packagedFiles = (await readdir(target)).sort();
if (JSON.stringify(packagedFiles) !== JSON.stringify([...runtimeFiles].sort())) {
  throw new Error(`Unsafe package contents: ${packagedFiles.join(', ')}`);
}
await rm(zipPath, { force: true });
await run('/usr/bin/zip', ['-qr', zipName, manifest.id], { cwd: 'dist' });
const { stdout } = await run('/usr/bin/unzip', ['-Z1', zipPath]);
const zipEntries = stdout.trim().split(/\r?\n/).filter(entry => !entry.endsWith('/')).sort();
const expectedEntries = runtimeFiles.map(file => `${manifest.id}/${file}`).sort();
if (JSON.stringify(zipEntries) !== JSON.stringify(expectedEntries)) {
  throw new Error(`Unsafe ZIP contents: ${zipEntries.join(', ')}`);
}
console.log(`Plugin package created at ${target} and ${zipPath}`);
