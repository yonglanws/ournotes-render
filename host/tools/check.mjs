#!/usr/bin/env node
// `npm run check`: validate config.yaml and the machine before starting the host. It never calls the LLM or TTS; use
// `npm run tts:check -- --synthesize` to make a real voice sample. Exit status 1 means an error the host cannot run
// with (for example a missing story site or an unreadable voices file).
import path from "node:path";
import { loadConfig, ensureDirs } from "../config.js";
import { formatReport, runDoctor } from "../doctor.js";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: node host/tools/check.mjs [--config file] [--json]");
  process.exit(0);
}

const file = option("--config");
const json = args.includes("--json");
try {
  const config = loadConfig({ file: file ? path.resolve(file) : undefined });
  ensureDirs(config);
  const report = runDoctor(config);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`ournotes host check\nconfig: ${config.configFile || "built-in defaults (no config.yaml)"}\n`);
    console.log(formatReport(report));
  }
  if (!report.ok) process.exitCode = 1;
} catch (e) {
  if (json) console.log(JSON.stringify({ ok: false, errors: [{ path: "config", message: e.message }], warnings: [] }, null, 2));
  else console.error(`configuration could not be loaded: ${e.message}`);
  process.exitCode = 1;
}
