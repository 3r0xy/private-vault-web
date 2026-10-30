import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('vendor', { recursive: true });
await build({
  entryPoints: { codemirror: 'scripts/codemirror-entry.mjs', d3: 'scripts/d3-entry.mjs' },
  outdir: 'vendor', bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
  minify: true, legalComments: 'eof',
});

// Distribute the license for every package included in the bundles.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const licenses = [];
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || pkg.dev || pkg.optional) continue;
  const metadata = JSON.parse(await readFile(`${path}/package.json`, 'utf8'));
  const license = await readFile(`${path}/LICENSE`, 'utf8');
  licenses.push(`${metadata.name}@${metadata.version}\n${license.trim()}`);
}
await writeFile('vendor/LICENSES.txt', licenses.join('\n\n---\n\n') + '\n');
