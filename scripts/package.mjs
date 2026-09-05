import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { promisify } from 'util';

const run = promisify(execFile);
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const target = `dist/${manifest.id}`;
const zipName = `${manifest.id}-${manifest.version}.zip`;
const zipPath = `dist/${zipName}`;
const releaseTarget = 'dist/release';

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

// BRAT downloads these three files directly from a GitHub Release; a valid
// installation ZIP alone is not sufficient for in-app updates.
await rm(releaseTarget, { recursive: true, force: true });
await mkdir(releaseTarget, { recursive: true });
await Promise.all([
  ...runtimeFiles.map(file => copyFile(file, `${releaseTarget}/${file}`)),
  copyFile(zipPath, `${releaseTarget}/${zipName}`),
]);
const releaseFiles = [zipName, ...runtimeFiles];
const checksums = [];
for (const file of releaseFiles) {
  const bytes = await readFile(`${releaseTarget}/${file}`);
  checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`);
}
await writeFile(`${releaseTarget}/SHA256SUMS.txt`, `${checksums.join('\n')}\n`);
const releaseEntries = (await readdir(releaseTarget)).sort();
const expectedReleaseEntries = [...releaseFiles, 'SHA256SUMS.txt'].sort();
if (JSON.stringify(releaseEntries) !== JSON.stringify(expectedReleaseEntries)) {
  throw new Error(`Unsafe release contents: ${releaseEntries.join(', ')}`);
}
console.log(`Plugin package created at ${target}, ${zipPath}, and ${releaseTarget}`);
