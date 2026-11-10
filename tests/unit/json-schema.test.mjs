// The schema validator used by scripts/validate-data.mjs (scripts/lib/json-schema.mjs), and the schemas in schema/
// against it. Synthetic inputs only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compile } from "../../scripts/lib/json-schema.mjs";

const schemaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "schema");

test("keywords", () => {
  const check = compile({
    type: "object",
    required: ["id", "kind"],
    properties: {
      id: { type: "integer", minimum: 1 },
      kind: { enum: ["a", "b"] },
      name: { type: "string", pattern: "^[a-z]+$" },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }], minItems: 2, maxItems: 2 },
      ref: { $ref: "#/$defs/nullable" },
      v: { const: 2 },
    },
    additionalProperties: false,
    $defs: { nullable: { type: ["integer", "null"] } },
  });
  assert.deepEqual(check({ id: 1, kind: "a", name: "abc", tags: ["x"], pair: ["k", 1.5], ref: null, v: 2 }), []);
  const errs = check({ id: 0.5, kind: "c", name: "A", tags: [1, "a", "b"], pair: ["k"], ref: "x", v: 3, extra: 1 });
  for (const re of [/\/id: expected integer/, /\/kind: "c" not one of/, /\/name: "A" does not match/, /\/tags\/0: expected string/,
                    /\/tags: more than 2/, /\/pair: fewer than 2/, /\/ref: expected integer or null/, /\/v: expected 2/, /\/extra: not allowed/])
    assert.ok(errs.some((e) => re.test(e)), `${re} in ${JSON.stringify(errs)}`);
  assert.deepEqual(check({}), ["/: missing id", "/: missing kind"]);
});

test("anyOf, propertyNames, additionalProperties schema", () => {
  const check = compile({
    type: "object",
    propertyNames: { pattern: "^[0-9]+$" },
    additionalProperties: { anyOf: [{ type: "string" }, { type: "object", required: ["x"] }] },
  });
  assert.deepEqual(check({ 1: "a", 2: { x: 1 } }), []);
  assert.equal(check({ a: "x" }).length, 1);
  assert.equal(check({ 1: 5 }).length, 1);
});

test("unsupported keywords are rejected", () => {
  assert.throws(() => compile({ type: "object", dependentRequired: {} }), /unsupported keyword dependentRequired/);
  assert.throws(() => compile({ $ref: "#/$defs/missing" }), /unresolved/);
});

test("every schema in schema/ compiles", () => {
  const names = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"));
  assert.ok(names.length >= 5);
  for (const f of names) compile(JSON.parse(fs.readFileSync(path.join(schemaDir, f), "utf8")));
});

test("the episode schema declares the official command fields the compiler writes", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, "episode.schema.json"), "utf8"));
  const props = schema.$defs.command.properties;
  assert.deepEqual(props.MotionFadeIn, { type: "number" });
  assert.deepEqual(props.MotionWait, { type: ["boolean", "number"] });
  assert.deepEqual(props.CanvasLayers, { type: "array", items: { type: "integer" } });
  assert.deepEqual(props.TargetTextColors, { type: "array", items: { type: "string" } });
  const check = compile(schema);
  const episode = {
    advId: 0, asset: "", commandCount: 3,
    commands: [
      { i: 0, cmd: "Motion", raw: 21, TargetName: "a", MotionName: "mtn_smile01", MotionFadeIn: -1, MotionWait: true },
      // the official rows store seconds (0.5, 1, 3.5 …), not a boolean
      { i: 1, cmd: "Motion", raw: 21, TargetName: "b", MotionName: "mtn_nod01", MotionWait: 3.5 },
      { i: 2, cmd: "DoF", raw: 48, Parameter1: "0.5", Duration: 1.5, CanvasLayers: [0, 2] },
    ],
    text: {}, sounds: {}, cuesheets: {}, videos: {}, resources: [],
    master: { _id: 0, _advEpisodeAsset: "", _titleTextId: "", _playbackMode: 0 }, title: null,
  };
  assert.deepEqual(check(episode), []);
  assert.ok(check({ ...episode, commands: [{ i: 0, cmd: "Motion", raw: 21, MotionWait: "wait" }] }).length);
});
