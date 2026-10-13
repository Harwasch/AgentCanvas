#!/usr/bin/env node
// Builds web/ in demo mode (mock hub, simulated data) and inlines everything into one HTML file:
//   node scripts/build-demo.mjs [out.html]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'web', 'dist-demo', 'agent-hub-demo.html'));
execFileSync('npx', ['vite', 'build', '-c', 'vite.demo.config.ts', '--logLevel', 'warn'], { cwd: WEB, stdio: 'inherit' });

const dist = path.join(WEB, 'dist-demo');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const jsFile = html.match(/<script[^>]+src="\.\/(assets\/[^"]+\.js)"/)[1];
const cssFile = html.match(/<link[^>]+href="\.\/(assets\/[^"]+\.css)"/)?.[1];
let js = fs.readFileSync(path.join(dist, jsFile), 'utf8').replace(/<\/script/gi, '<\\/script');
let css = cssFile ? fs.readFileSync(path.join(dist, cssFile), 'utf8') : '';
css = css.replace(/url\((['"]?)(?:\.{0,2}\/)*fonts\/([^'")]+)\1\)/g, (_m, _q, f) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(WEB, 'public', 'fonts', f)).toString('base64')})`);
const banner = `<div id="demo-badge" style="position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9999;font:500 11.5px/1 system-ui,sans-serif;color:#0B0C0E;background:#FFD23F;border-radius:999px;padding:7px 11px;pointer-events:none">Demo · simulated hosts, agents and GitHub</div>`;
const page = `<title>Agent Hub</title>
<meta name="color-scheme" content="dark">
<style>:root{color-scheme:dark}html,body{background:#0B0C0E}
${css}</style>
<div id="root"></div>
${banner}
<script type="module">
${js}
</script>
`;
fs.writeFileSync(out, page);
console.log(`${out} (${(page.length / 1024 / 1024).toFixed(2)} MB)`);
