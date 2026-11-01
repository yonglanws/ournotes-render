// A small leveled logger. One line per record; the level and a timestamp on every line so job logs stay greppable.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(level = "info", { scope = "", out = console } = {}) {
    this.level = LEVELS[String(level).toLowerCase()] || LEVELS.info;
    this.scope = scope;
    this.out = out;
  }

  child(scope) { return new Logger(this.levelName, { scope: this.scope ? `${this.scope}:${scope}` : scope, out: this.out }); }

  get levelName() { return Object.keys(LEVELS).find((k) => LEVELS[k] === this.level) || "info"; }

  _log(level, args) {
    if (LEVELS[level] < this.level) return;
    const ts = new Date().toISOString();
    const prefix = `${ts} ${level.toUpperCase().padEnd(5)}${this.scope ? ` [${this.scope}]` : ""}`;
    const target = level === "error" ? this.out.error : level === "warn" ? this.out.warn : this.out.log;
    target.call(this.out, prefix, ...args);
  }

  debug(...args) { this._log("debug", args); }
  info(...args) { this._log("info", args); }
  warn(...args) { this._log("warn", args); }
  error(...args) { this._log("error", args); }
}

export const logger = new Logger(process.env.OURNOTES_LOG_LEVEL || "info");
