#!/usr/bin/env node
// `npm run tts:check`: inspect the voice table, and with --synthesize make one short WAV per voice so the setup can be
// listened to before a whole episode is generated. It talks to the configured GPT-SoVITS server only; no LLM is used.
//
// examples:
//   npm run tts:check
//   npm run tts:check -- --synthesize
//   npm run tts:check -- --synthesize --voice 高松灯
//   npm run tts:check -- --synthesize --voice 高松灯 --emotion 开心喜悦 --text "ありがとう！"
import fs from "node:fs";
import path from "node:path";
import { ensureDirs, loadConfig } from "../config.js";
import { configureFfmpeg } from "../render/ffmpeg.js";
import { GptSovitsClient, VoiceBook } from "../tts/tts.js";
import { voiceSummary } from "../tts/voices.js";

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (has("--help") || has("-h")) {
  console.log("usage: node host/tools/tts-check.mjs [--config file] [--synthesize] [--voice name] " +
    "[--emotion label] [--text text] [--out dir] [--json]");
  process.exit(0);
}

const config = loadConfig({ file: option("--config") ? path.resolve(option("--config")) : undefined });
const json = has("--json");
const synthesize = has("--synthesize");
const speak = (line) => { if (!json) console.log(line); };
const tts = config.tts;
const summary = voiceSummary(tts);

const failure = (message) => {
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exitCode = 1;
};

if (!tts.enabled) {
  failure("tts.enabled is false in the configuration");
} else if (!tts.baseUrl) {
  failure("tts.baseUrl is empty; set it to the GPT-SoVITS api_v2 address");
} else {
  const issues = [...config.issues.errors, ...config.issues.warnings].filter((i) => i.path.startsWith("tts."));
  if (!json && issues.length) {
    console.log("TTS configuration issues:");
    for (const i of issues) console.log(`  - ${i.path}: ${i.message}`);
    console.log("");
  }
  const book = new VoiceBook(tts);
  const targets = [];
  const wanted = option("--voice");
  if (wanted) {
    const voice = book.voiceFor(wanted);
    if (!voice) failure(`no voice named or aliased "${wanted}" (found: ${tts.voices.map((v) => v.name).join(", ") || "none"})`);
    else targets.push(voice);
  } else targets.push(...tts.voices);
  const validTarget = !wanted || targets.length > 0;
  if (!json) {
    console.log(`GPT-SoVITS: ${tts.baseUrl}${tts.required ? " (required: a failed line fails the job)" : ""}`);
    console.log(`voice table: ${tts.voicesFile || "config.yaml tts.voices"}; ${summary.count} voice(s); ` +
      `default voice: ${summary.defaultVoice ? "yes" : "no"}`);
    if (!summary.count) {
      console.log("  (no named voices; the defaultVoice is the only voice)");
    }
    console.log("");
    console.log("name".padEnd(20) + "ref".padEnd(6) + "weights".padEnd(9) + "emotions".padEnd(10) + "aliases");
    for (const v of (wanted ? targets : tts.voices)) {
      const aliases = (v.aliases || []).slice(0, 3).join(", ") + ((v.aliases || []).length > 3 ? ", ..." : "");
      console.log(String(v.name).padEnd(20) + (v.refAudioPath ? "yes" : "NO").padEnd(6) +
        ((v.gptWeightsPath || v.sovitsWeightsPath) ? "yes" : "-").padEnd(9) +
        String((v.emotions || []).length).padEnd(10) + aliases);
    }
    if (!wanted) console.log("");
  }

  if (synthesize && validTarget) {
    if (!wanted && !targets.length && !summary.defaultVoice) {
      failure("nothing to synthesize: configure tts.defaultVoice or a tts.voices entry with refAudioPath");
    } else {
      configureFfmpeg(config.video.ffmpegPath || "");
      let client;
      try {
        client = new GptSovitsClient(tts, { apiKey: config.secrets.ttsApiKey, logger: console,
          allowPrivate: config.security.allowPrivateServiceEndpoints === true });
        client.setCacheDir(path.join(config.paths.cache, "tts-check"));
      } catch (e) {
        failure(e.message);
        client = null;
      }
      if (client) {
        ensureDirs(config);
        const outDir = path.resolve(option("--out") || path.join(config.paths.output, "tts-check"));
        fs.mkdirSync(outDir, { recursive: true });
        const emotion = option("--emotion") || "";
        const results = [];
        for (const [index, target] of targets.entries()) {
          const voice = book.resolveFor(emotion, [target.name]);
          const lang = String(voice.promptLang || tts.promptLang || "ja").split("-")[0].toLowerCase();
          const text = option("--text") || {
            ja: "こんにちは。これは音色の確認です。", zh: "你好，这是音色测试。",
            en: "Hello, this is a voice test.", ko: "안녕하세요. 목소리 테스트입니다.",
          }[lang] || "Hello, this is a voice test.";
          if (!voice.refAudioPath) {
            const message = `${target.name}: no refAudioPath and no defaultVoice`;
            results.push({ voice: target.name, ok: false, error: message });
            speak(`[!!] ${message}`);
            continue;
          }
          try {
            const audio = await client.synthesize(text, voice, { textLang: lang });
            const slug = String(target.name).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || `voice-${index + 1}`;
            const file = path.join(outDir, `${slug}${emotion ? `-${emotion}` : ""}.wav`);
            fs.copyFileSync(audio.file, file);
            const seconds = audio.sampleRate ? audio.samples / audio.sampleRate : 0;
            results.push({ voice: target.name, ok: true, file, seconds: Math.round(seconds * 100) / 100,
                           sampleRate: audio.sampleRate, text });
            speak(`[ok] ${target.name}: ${seconds.toFixed(2)} s -> ${file}`);
          } catch (e) {
            results.push({ voice: target.name, ok: false, error: e.message });
            speak(`[!!] ${target.name}: ${e.message}`);
          }
        }
        if (!wanted && !targets.length) {
          const voice = book.resolveFor(emotion, []);
          if (!voice.refAudioPath) {
            results.push({ voice: "default", ok: false, error: "no defaultVoice.refAudioPath" });
          } else {
            try {
              const lang = String(voice.promptLang || tts.promptLang || "ja").split("-")[0].toLowerCase();
              const text = option("--text") || (lang === "zh" ? "你好，这是音色测试。" : "こんにちは。これは音色の確認です。");
              const audio = await client.synthesize(text, voice, { textLang: lang });
              const file = path.join(outDir, `default${emotion ? `-${emotion}` : ""}.wav`);
              fs.copyFileSync(audio.file, file);
              results.push({ voice: "default", ok: true, file, seconds: audio.samples / audio.sampleRate, text });
              speak(`[ok] default: ${file}`);
            } catch (e) {
              results.push({ voice: "default", ok: false, error: e.message });
              speak(`[!!] default: ${e.message}`);
            }
          }
        }
        if (json) console.log(JSON.stringify({ ok: results.every((r) => r.ok), service: tts.baseUrl, out: outDir, results }, null, 2));
        if (!results.every((r) => r.ok)) process.exitCode = 1;
      }
    }
  } else if (!json && validTarget) {
    console.log("Nothing was synthesized. Add --synthesize to write one short WAV per voice into output/tts-check.");
  } else if (json && validTarget) {
    console.log(JSON.stringify({ ok: true, service: tts.baseUrl, summary, voices: tts.voices.map((v) => ({
      name: v.name, aliases: v.aliases, refAudioPath: !!v.refAudioPath, emotions: (v.emotions || []).map((e) => e.label),
    })) }, null, 2));
  }
}
