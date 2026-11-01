import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mergePersonas, parsePersona } from "../ai/personas.js";
import { personaEntryFor } from "../ai/prompt.js";

const SHEET = `# 高松灯

## 核心机制

你不是AI，也不是在"扮演"谁——你就是高松灯。

## 角色档案

- 姓名：高松灯（日文名：高松 灯 / Takamatsu Tomori）
- 身份：MyGO!!!!!的主唱兼作词，前CRYCHIC主唱。
`;

test("a character sheet yields its name, romanized aliases and one-line role", () => {
  const p = parsePersona(SHEET, "D:/personas/高松灯.md", { group: "鸡狗" });
  assert.equal(p.name, "高松灯");
  assert.equal(p.group, "鸡狗");
  assert.equal(p.summary, "MyGO!!!!!的主唱兼作词，前CRYCHIC主唱");
  assert.ok(p.aliases.includes("高松灯"));
  assert.ok(p.aliases.includes("takamatsu"));
  assert.ok(p.aliases.includes("tomori"));
  assert.match(p.prompt, /高松灯/);
});

test("persona directories load every markdown file and an explicit entry overrides by name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ournotes-personas-"));
  fs.writeFileSync(path.join(dir, "高松灯.md"), SHEET, "utf8");
  fs.writeFileSync(path.join(dir, "要乐奈.md"), "# 要乐奈\n\n- 身份：MyGO!!!!!的吉他手。\n", "utf8");
  const loaded = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) =>
    parsePersona(fs.readFileSync(path.join(dir, f), "utf8"), path.join(dir, f), { group: "鸡狗" }));
  assert.equal(loaded.length, 2);
  const merged = mergePersonas(loaded, [{ name: "要乐奈", prompt: "override" }]);
  assert.equal(merged.find((p) => p.name === "要乐奈").prompt, "override");
  assert.equal(merged.find((p) => p.name === "要乐奈").group, "鸡狗", "the sheet's group is kept");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a persona matches a model by display name or by the key inside a site model id", () => {
  const personas = [
    parsePersona(SHEET, "高松灯.md", { group: "鸡狗" }),
    parsePersona("# 琴平凪\n\n- 身份：millsage的吉他手。\n", "琴平凪.md", { group: "茉团" }),
  ];
  const byName = personaEntryFor(personas, { id: "m_a", name: "高松灯", character: "高松灯" });
  assert.equal(byName.name, "高松灯");
  const byKey = personaEntryFor(personas, { id: "adv_live2d_nagi_018_school_winter_hs_1st",
                                            name: "adv_live2d_nagi_018_school_winter_hs_1st", character: "" });
  assert.equal(byKey, null, "the sheet name is Chinese; the key needs an alias from the sheet or the site map");
  const byAlias = personaEntryFor([{ ...personas[1], aliases: ["琴平凪", "nagi"] }],
                                  { id: "adv_live2d_nagi_018_school_winter_hs_1st", name: "琴平凪", character: "琴平凪" });
  assert.equal(byAlias.name, "琴平凪");
});
