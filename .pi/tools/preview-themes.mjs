#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ANSI = { reset: '\x1b[0m' };
const colorKeys = [
  'accent','border','borderAccent','success','error','warning','muted','dim','text',
  'selectedBg','userMessageBg','toolPendingBg','toolSuccessBg','toolErrorBg','toolTitle','toolOutput',
  'mdHeading','mdLink','mdCode','toolDiffAdded','toolDiffRemoved',
  'syntaxKeyword','syntaxFunction','syntaxString','syntaxNumber','thinkingMedium','bashMode'
];

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function xtermToRgb(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  const basic = [
    [0,0,0],[128,0,0],[0,128,0],[128,128,0],[0,0,128],[128,0,128],[0,128,128],[192,192,192],
    [128,128,128],[255,0,0],[0,255,0],[255,255,0],[0,0,255],[255,0,255],[0,255,255],[255,255,255]
  ];
  if (n < 16) return basic[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return [v, v, v]; }
  n -= 16;
  const r = Math.floor(n / 36), g = Math.floor((n % 36) / 6), b = n % 6;
  const scale = v => v === 0 ? 0 : 55 + v * 40;
  return [scale(r), scale(g), scale(b)];
}

function resolveColor(value, vars = {}) {
  if (value === '') return undefined;
  const raw = typeof value === 'string' && vars[value] !== undefined ? vars[value] : value;
  if (typeof raw === 'number') return xtermToRgb(raw);
  if (typeof raw === 'string') return hexToRgb(raw);
  return undefined;
}

function fg(rgb) { return rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : ''; }
function bg(rgb) { return rgb ? `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : ''; }
function swatch(rgb) { return rgb ? `${bg(rgb)}  ${ANSI.reset}` : '··'; }

function readTheme(file) {
  const theme = JSON.parse(readFileSync(file, 'utf8'));
  return { file, theme };
}

function collect(paths) {
  const files = [];
  for (const p of paths) {
    const path = resolve(p.replace(/^~(?=$|[\\/])/, process.env.HOME || process.env.USERPROFILE || '~'));
    if (!existsSync(path)) continue;
    if (path.endsWith('.json')) files.push(path);
    else for (const f of readdirSync(path)) if (f.endsWith('.json')) files.push(join(path, f));
  }
  return files;
}

const args = process.argv.slice(2);
const defaultPaths = ['.pi/themes', `${process.env.HOME || process.env.USERPROFILE}/.pi/agent/themes`];
const files = collect(args.length ? args : defaultPaths);
if (!files.length) {
  console.error('Usage: node .pi/tools/preview-themes.mjs <theme.json-or-dir> [...more]');
  process.exit(1);
}

for (const file of files) {
  const { theme } = readTheme(file);
  console.log(`\n${theme.name || file}  (${file})`);
  console.log('─'.repeat(Math.min(96, process.stdout.columns || 96)));
  for (const key of colorKeys) {
    const val = theme.colors?.[key];
    const rgb = resolveColor(val, theme.vars);
    const label = key.padEnd(18);
    console.log(`${label} ${swatch(rgb)} ${fg(rgb)}${String(val).padEnd(14)} sample text${ANSI.reset}`);
  }
  const text = resolveColor(theme.colors?.text, theme.vars);
  const muted = resolveColor(theme.colors?.muted, theme.vars);
  const userBg = resolveColor(theme.colors?.userMessageBg, theme.vars);
  const toolBg = resolveColor(theme.colors?.toolPendingBg, theme.vars);
  console.log('\nmessage preview');
  console.log(`${bg(userBg)}${fg(text)}  You: does this contrast feel readable?${ANSI.reset}`);
  console.log(`${bg(toolBg)}${fg(muted)}  Tool: pending/output backgrounds and muted text${ANSI.reset}`);
}
