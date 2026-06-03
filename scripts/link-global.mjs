#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepo = resolve(scriptDir, "..");
const env = { ...readDotEnv(join(defaultRepo, ".env")), ...process.env };
const repo = resolve(env.PI_PROJECT_FLOW_REPO || env.PROJECT_FLOW_REPO || defaultRepo);
const target = join(repo, ".pi", "extensions", "project-flow");
const link = join(homedir(), ".pi", "agent", "extensions", "project-flow");

if (!existsSync(target)) {
  console.error(`Project Flow extension not found: ${target}`);
  process.exit(1);
}

mkdirSync(dirname(link), { recursive: true });
if (existsSync(link)) {
  const stat = lstatSync(link);
  if (!stat.isSymbolicLink()) {
    console.error(`Refusing to replace non-symlink: ${link}`);
    console.error("Remove or rename it manually, then rerun this script.");
    process.exit(1);
  }
  rmSync(link);
}

symlinkSync(target, link, "dir");
console.log(`Linked Project Flow globally:\n  ${link}\n-> ${target}`);
console.log("Restart pi or run /reload in an existing session.");
console.log("If you also listed this extension in ~/.pi/agent/settings.json packages, remove that package entry to avoid duplicate tools.");
