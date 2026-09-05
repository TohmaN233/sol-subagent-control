import { build } from 'esbuild';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({ absWorkingDir: root, tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
  stdin: { contents: "import './web-src/main.tsx';", resolveDir: root, sourcefile: 'workflow-entry.tsx', loader: 'tsx' }, outfile: 'web/workflows.js', bundle: true,
  write: false, metafile: true, format: 'esm', minify: true, sourcemap: false, target: ['chrome120', 'firefox121', 'safari17'], legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"' } });
const packages = [...new Set(Object.keys(result.metafile.inputs).filter(path => path.startsWith('node_modules/')).map(path => {
  const parts = path.split('/'); return parts.slice(0, parts[1].startsWith('@') ? 3 : 2).join('/');
}))].sort();
const licenses = [];
for (const path of packages) {
  const metadata = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
  const files = (await readdir(join(root, path))).filter(name => /^licen[sc]e(?:\..*)?$/i.test(name)).sort();
  if (!files.length) throw new Error('Bundled package has no license file: ' + metadata.name);
  licenses.push(metadata.name + '@' + metadata.version + '\n' + (await Promise.all(files.map(file => readFile(join(root, path, file), 'utf8')))).join('\n'));
}
const outputs = [...result.outputFiles, { path: join(root, 'web', 'workflows.LICENSE.txt'), contents: Buffer.from(licenses.join('\n\n--------------------\n\n').replace(/\r\n/g, '\n') + '\n') }];
for (const output of outputs) {
  if (process.argv.includes('--check')) {
    const existing = await readFile(output.path);
    if (!existing.equals(Buffer.from(output.contents))) throw new Error('Committed web asset differs: ' + output.path);
  } else await writeFile(output.path, output.contents);
}
console.log(process.argv.includes('--check') ? 'Workflow web assets match source' : 'Workflow web assets built');
