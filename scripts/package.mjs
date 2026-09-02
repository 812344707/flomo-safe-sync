import { execFile } from 'child_process';
import { copyFile, mkdir, readFile, rm } from 'fs/promises';
import { promisify } from 'util';

const run = promisify(execFile);
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const target = `dist/${manifest.id}`;
const zipName = `${manifest.id}-${manifest.version}.zip`;
const zipPath = `dist/${zipName}`;

await mkdir(target, { recursive: true });
await Promise.all(
  ['main.js', 'manifest.json', 'styles.css'].map(file => copyFile(file, `${target}/${file}`)),
);
await rm(zipPath, { force: true });
await run('/usr/bin/zip', ['-qr', zipName, manifest.id], { cwd: 'dist' });
console.log(`Plugin package created at ${target} and ${zipPath}`);
