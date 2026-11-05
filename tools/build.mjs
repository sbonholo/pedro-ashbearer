// Production copy in dist/ (what gets published): same files, JS/CSS minified per file.
// Source in js/ and css/ stays readable and runs as-is (open index.html via any static server or file://).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { transform } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
const copy = (rel) => { const to = path.join(dist, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(root, rel), to); };
const ls = (dir) => fs.readdirSync(path.join(root, dir)).map((f) => dir + '/' + f);

let raw = 0, gz = 0;
const out = (rel, data) => { const to = path.join(dist, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, data); };
copy('index.html');
for (const f of [...ls('fonts'), ...ls('vendor')]) copy(f);
for (const f of ls('css')) {
  const r = await transform(fs.readFileSync(path.join(root, f), 'utf8'), { loader: 'css', minify: true });
  out(f, r.code);
}
for (const f of ls('js')) {
  // classic scripts: no `format`, so top-level names (the shared `AB`) are kept
  const r = await transform(fs.readFileSync(path.join(root, f), 'utf8'), { loader: 'js', minify: true, target: 'es2020' });
  out(f, r.code);
}
for (const f of ['index.html', ...ls('css'), ...ls('js'), 'vendor/three.bundle.js']) {
  const b = fs.readFileSync(path.join(dist, f)); raw += b.length; gz += zlib.gzipSync(b, { level: 9 }).length;
}
console.log(`dist/: page + css + js = ${(raw / 1024).toFixed(0)} KB raw, ${(gz / 1024).toFixed(0)} KB gzip (fonts load on demand)`);
