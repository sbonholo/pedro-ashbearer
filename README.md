# Ashbearer

3D fantasy party RPG — walk the party through three regions and fight in real time.

Made by **Pedro** with Claude.

- Play (Claude Artifact): https://claude.ai/artifact/BHyTyDZsNZcYUHDxfm78ZR
- Play locally: open `index.html` (works from a static server, e.g. `npm run serve`, or straight from disk)

## Layout
| Path | What |
|---|---|
| `index.html` | page shell + loading screen |
| `css/style.css`, `css/fonts.css` | styles; self-hosted fonts (`fonts/*.woff2`) |
| `js/boot.js` | loads everything in order, progress bar, "tap to reload" error toast |
| `js/content.js` | game data (acts, events, items, text) |
| `js/core.js` … `js/main.js` | engine modules, loaded in this order: core, textures, world, actors, vfx, combat, ui, audio, game, main |
| `vendor/three.bundle.js` | three.js 0.170.0 + addons (no CDN at runtime) |
| `tools/` | `vendor.mjs` (rebuild vendor + fonts from npm), `build.mjs` (minified copy in `dist/` for publishing) |

The JS files are classic scripts sharing one global `AB` (declared in `core.js`); keep `import`/`export` out of them.

## Commands
```bash
npm install        # three, fonts, esbuild (dev only)
npm run vendor     # rebuild vendor/three.bundle.js + fonts after a version bump
npm run build      # dist/ = minified copy that gets published as the Artifact
```

Debug hooks in the browser console: `__ab.state()`, `__ab.fps()`, `__ab.bootTimes()`, `__ab.setQuality('low')`.

## Rules for this repo
This repo is Pedro's only. Keep all work on this game here — never in Dad's work repos (beija, money, Arborium, Salsa, Gymgosh, etc.).
