import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ROOT, loadConfig } from "../config.js";
import { formatReport, runDoctor } from "../doctor.js";

test("the shipped example config loads and the doctor reports every section", () => {
  const config = loadConfig({ file: path.join(ROOT, "config.example.yaml") });
  assert.equal(config.issues.errors.length, 0, JSON.stringify(config.issues.errors));
  const report = runDoctor(config);
  for (const name of ["node", "output", "cache", "ffmpeg", "browser", "siteEngine", "core", "personas", "llm", "tts"]) {
    assert.ok(report.checks[name], `missing check ${name}`);
  }
  assert.equal(report.checks.tts.voices.count, 0);
  assert.ok(report.warnings.some((w) => w.path === "tts.voices"), "an empty voice table is a warning, not a crash");
  assert.match(formatReport(report), /tts:/);
});
