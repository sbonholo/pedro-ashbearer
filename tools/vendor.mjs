// Rebuilds the vendored third-party files from npm (run after `npm install`):
//   vendor/three.bundle.js  three.js + the addons in tools/vendor-entry.js, minified IIFE -> window.ABVendor
//   fonts/*.woff2 + css/fonts.css  self-hosted fonts (latin + latin-ext), from @fontsource
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const nm = path.join(root, 'node_modules');

await build({
  entryPoints: [path.join(root, 'tools/vendor-entry.js')], bundle: true, minify: true, format: 'iife', globalName: 'ABVendor',
  target: 'es2020', legalComments: 'eof', outfile: path.join(root, 'vendor/three.bundle.js'), logLevel: 'info'
});
fs.copyFileSync(path.join(nm, 'three/LICENSE'), path.join(root, 'vendor/three.LICENSE'));

const FONTS = [['alegreya', ['400', '500', '700', '400-italic', '500-italic']], ['alegreya-sans-sc', ['400', '500', '700']], ['grenze-gotisch', ['400', '500', '700']]];
let css = '/* Self-hosted fonts (woff2, from @fontsource; SIL OFL 1.1). latin + latin-ext only; the browser downloads a face only when a glyph needs it. */\n';
fs.mkdirSync(path.join(root, 'fonts'), { recursive: true });
for (const [pkg, weights] of FONTS) for (const w of weights) {
  const txt = fs.readFileSync(path.join(nm, '@fontsource', pkg, w + '.css'), 'utf8');
  for (const blk of txt.split(/\n(?=\/\*)/)) {
    const m = blk.match(/^\/\* ([\w-]+) \*\//);
    if (!m || !/-latin(-ext)?-\d+-(normal|italic)$/.test(m[1])) continue;
    const file = m[1] + '.woff2';
    fs.copyFileSync(path.join(nm, '@fontsource', pkg, 'files', file), path.join(root, 'fonts', file));
    css += blk.trim().replace(/src: [^;]+;/, `src: url(../fonts/${file}) format("woff2");`) + '\n';
  }
}
fs.writeFileSync(path.join(root, 'css/fonts.css'), css);
console.log('fonts: css/fonts.css + fonts/*.woff2');
