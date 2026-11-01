// Character sheets kept outside the repository: each `*.md` in an operator-configured directory is one persona. The
// staged writer only puts the sheets of the selected cast into the dialogue pass, so a 20 KB sheet per character is
// fine. A sheet's name, file stem, Japanese name and romanized name become aliases, which is how a site model id such
// as `adv_live2d_nagi_018_school_winter_hs_1st` finds 琴平凪.
import fs from "node:fs";
import path from "node:path";

const clean = (v) => String(v ?? "").replace(/^\uFEFF/, "").trim();

const headingOf = (text) => {
  const m = /^#\s+(.+?)\s*$/m.exec(text);
  return m ? clean(m[1]) : "";
};

// The `- 身份：…` line of the sheet is a one-line role; fall back to the first sentence of 核心机制.
const summaryOf = (text) => {
  const identity = /^-\s*\*{0,2}身份\*{0,2}[：:]\s*(.+)$/m.exec(text);
  if (identity) return clean(identity[1]).split(/[；;。]/)[0].slice(0, 120);
  const core = /##\s*核心机制\s*\n+([^\n]+)/.exec(text);
  if (!core) return "";
  return clean(core[1])
    .replace(/^你(?:不是AI[^—]*—[^—]*—|(?:就)?是[^，,。]*[，,]?)/, "")
    .slice(0, 120);
};

const asciiToken = (token) => token.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z]/g, "");

const aliasesOf = (text, name, file) => {
  const out = new Set([name, path.basename(file, path.extname(file))]);
  const block = /日文名[：:]\s*([^\n）)]+)/.exec(text);
  const nameLine = /^-\s*\*{0,2}姓名\*{0,2}[：:]\s*(.+)$/m.exec(text);
  const paren = /[（(]([^）)]*[A-Za-z][^）)]*)[）)]/.exec(nameLine ? nameLine[1] : text);
  const raw = block ? block[1] : paren ? paren[1] : "";
  if (raw) {
    const ascii = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const romanOnly = /^[A-Za-z\s.·'-]+$/.test(ascii);
    const parts = romanOnly ? [raw] : raw.split("/");
    const jpRaw = romanOnly ? "" : clean(parts[0]);
    if (jpRaw) out.add(jpRaw);
    const jp = jpRaw.replace(/\s+/g, "");
    if (jp) out.add(jp);
    const roman = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
    for (const token of roman.split(/[\s/·,，]+/)) {
      const word = asciiToken(token);
      if (word.length >= 3) out.add(word.toLowerCase());
    }
  }
  return [...out].filter(Boolean);
};

export const parsePersona = (text, file, { group = "" } = {}) => {
  const source = clean(text);
  const name = headingOf(source) || path.basename(file, path.extname(file));
  return {
    name,
    group,
    prompt: source,
    summary: summaryOf(source),
    aliases: aliasesOf(source, name, file),
    source: file,
  };
};

// Reads every `*.md` of every directory in order. A missing directory is a warning, not a startup failure: the rest of
// the site keeps working.
export const loadPersonaDirs = (dirs, { logger = console } = {}) => {
  const out = [];
  for (const dir of dirs || []) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort();
    } catch (e) {
      logger.warn?.(`personaDirs: ${dir}: ${e.message}`);
      continue;
    }
    for (const file of files) {
      try {
        out.push(parsePersona(fs.readFileSync(path.join(dir, file), "utf8"), path.join(dir, file),
                              { group: path.basename(dir) }));
      } catch (e) {
        logger.warn?.(`personaDirs: ${path.join(dir, file)}: ${e.message}`);
      }
    }
  }
  return out;
};

// Directory sheets first; an explicit `story.personas` entry with the same name overrides its fields (a prompt-only
// override keeps the sheet's group, summary and aliases).
export const mergePersonas = (fromDirs, explicit) => {
  const out = [...fromDirs];
  const at = new Map(out.map((p, i) => [p.name, i]));
  for (const raw of explicit || []) {
    if (!raw || !raw.name) continue;
    const name = clean(raw.name);
    const index = at.get(name);
    const base = index != null ? out[index] : {};
    const p = {
      ...base,
      ...raw,
      name,
      aliases: [...new Set([name, ...(base.aliases || []), ...(Array.isArray(raw.aliases) ? raw.aliases : [])])],
    };
    if (index != null) out[index] = p;
    else { at.set(name, out.length); out.push(p); }
  }
  return out.filter((p) => p.name && p.prompt);
};
