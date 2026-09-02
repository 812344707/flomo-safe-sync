import esbuild from 'esbuild';
import { spawnSync } from 'child_process';
import process from 'process';

const outfile = '.test-dist/sync-core.test.cjs';

await esbuild.build({
  entryPoints: ['tests/sync-core.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile,
  logLevel: 'info',
});

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
process.exit(result.status ?? 1);
