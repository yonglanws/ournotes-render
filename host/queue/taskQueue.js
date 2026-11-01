// In-memory task queue for the whole backend: AI writing, TTS and rendering run inside one task, so the queue sees the
// complete pipeline. Priorities order the wait list; tasks of the same priority run first-in first-out.
import crypto from "node:crypto";

export class QueueFullError extends Error {
  constructor(message) { super(message); this.name = "QueueFullError"; this.code = "queue_full"; }
}
export class TaskCancelledError extends Error {
  constructor(message = "task cancelled") { super(message); this.name = "TaskCancelledError"; this.code = "cancelled"; }
}
export class TaskTimeoutError extends Error {
  constructor(message) { super(message); this.name = "TaskTimeoutError"; this.code = "timeout"; }
}

const id = () => `task-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
const now = () => Date.now();

export class TaskQueue {
  constructor({ concurrency = 1, maxSize = 20, taskTimeoutMs = 3600000, retentionMs = 3600000,
                cleanupIntervalMs = 600000, logger = console } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.maxSize = Math.max(1, maxSize);
    this.taskTimeoutMs = Math.max(1000, taskTimeoutMs);
    this.retentionMs = Math.max(0, retentionMs);
    this.logger = logger;
    this.tasks = new Map();
    this.pending = [];
    this.running = new Map();
    this.stats = { enqueued: 0, completed: 0, failed: 0, cancelled: 0 };
    this._closed = false;
    this._cleanup = setInterval(() => this._prune(), Math.max(1000, cleanupIntervalMs));
    this._cleanup.unref?.();
  }

  // run: async (ctx) => result, ctx = {signal, progress(phase, value), task}
  submit({ userId = "", priority = 0, label = "", run }) {
    if (this._closed) throw new QueueFullError("the queue is closed");
    if (this.pending.length + this.running.size >= this.maxSize)
      throw new QueueFullError(`the queue is full (${this.maxSize}); try again later`);
    const task = {
      id: id(), userId, priority, label, run, status: "queued", phase: "queued", progress: 0, message: "",
      createdAt: now(), startedAt: null, completedAt: null, result: null, error: null,
      cancelRequested: false, controller: null, promise: null, resolve: null, reject: null,
    };
    task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    // A caller that only polls must not produce unhandled rejections; awaiters still see the rejection.
    task.promise.catch(() => {});
    this.tasks.set(task.id, task);
    this.pending.push(task);
    this.stats.enqueued++;
    this.logger.info?.(`queued ${task.id}${label ? ` (${label})` : ""}, ${this.pending.length} waiting, ${this.running.size} running`);
    queueMicrotask(() => this._pump());
    return task;
  }

  // The task record as the API shows it; no functions.
  view(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    return {
      taskId: t.id, status: t.status, phase: t.phase, progress: t.progress, message: t.message,
      label: t.label, createdAt: t.createdAt, startedAt: t.startedAt, completedAt: t.completedAt,
      elapsedSeconds: t.startedAt ? Math.round(((t.completedAt || now()) - t.startedAt) / 100) / 10 : 0,
      queuePosition: t.status === "queued" ? this.pending.indexOf(t) + 1 : null,
      error: t.error ? { code: t.error.code || "error", message: t.error.message } : null,
      result: t.status === "completed" ? t.result : null,
    };
  }

  list({ status = null, limit = 100 } = {}) {
    let list = [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (status) list = list.filter((t) => t.status === status);
    return list.slice(0, limit).map((t) => this.view(t.id));
  }

  summary() {
    return {
      waiting: this.pending.length, running: this.running.size, concurrency: this.concurrency,
      maxSize: this.maxSize, ...this.stats,
      activeTaskIds: [...this.running.keys()], queuedTaskIds: this.pending.map((t) => t.id),
    };
  }

  cancel(taskId, reason = "cancelled by user") {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.status === "queued") {
      this.pending = this.pending.filter((x) => x !== t);
      this._settle(t, "cancelled", null, new TaskCancelledError(reason));
      return true;
    }
    if (t.status === "running") {
      t.cancelRequested = true;
      t.controller?.abort(new TaskCancelledError(reason));
      return true;
    }
    return false;
  }

  async close() {
    this._closed = true;
    clearInterval(this._cleanup);
    for (const t of [...this.pending]) this.cancel(t.id, "server shutting down");
    for (const t of [...this.running.values()]) t.controller?.abort(new TaskCancelledError("server shutting down"));
    const waits = [...this.running.values()].map((t) => t.promise.catch(() => {}));
    await Promise.all(waits);
  }

  _pump() {
    if (this._closed) return;
    while (this.running.size < this.concurrency && this.pending.length) {
      this.pending.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      const task = this.pending.shift();
      if (!task || task.status !== "queued") continue;
      this._start(task);
    }
  }

  _start(task) {
    task.status = "running";
    task.phase = "starting";
    task.startedAt = now();
    task.controller = new AbortController();
    this.running.set(task.id, task);
    const timer = setTimeout(() => {
      task.controller.abort(new TaskTimeoutError(`task timed out after ${Math.round(this.taskTimeoutMs / 1000)} s`));
    }, this.taskTimeoutMs);
    timer.unref?.();

    const ctx = {
      signal: task.controller.signal,
      task,
      progress: (phase, progress = null, message = "") => {
        if (task.status !== "running") return;
        task.phase = String(phase || task.phase);
        if (Number.isFinite(progress)) task.progress = Math.max(0, Math.min(1, progress));
        if (message) task.message = String(message);
      },
    };
    const runPromise = (async () => {
      try {
        const result = await task.run(ctx);
        if (task.cancelRequested) throw new TaskCancelledError();
        this._settle(task, "completed", result, null);
        this.stats.completed++;
        return result;
      } catch (e) {
        const err = task.cancelRequested && !(e instanceof TaskCancelledError)
          ? new TaskCancelledError("task cancelled") : e;
        if (err instanceof TaskCancelledError) {
          this._settle(task, "cancelled", null, err);
          this.stats.cancelled++;
        } else {
          this._settle(task, "failed", null, err);
          this.stats.failed++;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        this.running.delete(task.id);
        queueMicrotask(() => this._pump());
      }
    })();
    runPromise.catch(() => {});
    this.logger.info?.(`started ${task.id}${task.label ? ` (${task.label})` : ""}`);
  }

  _settle(task, status, result, error) {
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;
    task.status = status;
    task.completedAt = now();
    task.result = result || null;
    task.error = error || null;
    task.phase = status;
    if (status === "completed") task.progress = 1;
    if (this.running.get(task.id) === task) this.running.delete(task.id);
    if (status === "completed") task.resolve?.(result);
    else task.reject?.(error || new Error(status));
    this.logger[status === "failed" ? "error" : "info"]?.(
      `${tag(task)} ${status}${error ? `: ${error.message}` : ""}`);
    queueMicrotask(() => this._pump());
  }

  _prune() {
    const cutoff = now() - this.retentionMs;
    for (const [taskId, t] of this.tasks) {
      if ((t.status === "completed" || t.status === "failed" || t.status === "cancelled") &&
          t.completedAt && t.completedAt < cutoff) this.tasks.delete(taskId);
    }
    if (this._closed) clearInterval(this._cleanup);
  }
}

const tag = (t) => `${t.id}${t.label ? ` (${t.label})` : ""}`;
