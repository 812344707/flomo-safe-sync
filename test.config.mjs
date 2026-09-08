import esbuild from 'esbuild';
import { spawnSync } from 'child_process';
import process from 'process';

for (const suite of ['sync-core', 'managed-safety', 'plugin-safety', 'v030', 'folder-migration']) {
  const outfile = `.test-dist/${suite}.test.cjs`;
  await esbuild.build({
    entryPoints: [`tests/${suite}.test.ts`],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile,
    logLevel: 'info',
    alias: { obsidian: './tests/obsidian-mock.ts' },
  });

  const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
