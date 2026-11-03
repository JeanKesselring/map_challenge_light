export type StartupStage = 'application' | 'renderer' | 'terrain' | 'texture' | 'geometry' | 'lighting' | 'first-frame';

export class StartupError extends Error {
  readonly stage: StartupStage;
  readonly reason: 'timeout' | 'cancelled';
  constructor(stage: StartupStage, reason: 'timeout' | 'cancelled') {
    super(`Map startup ${reason} during ${stage}.`);
    this.name = 'StartupError'; this.stage = stage; this.reason = reason;
  }
}

/** One deadline covers module loading, data, decoding and renderer readiness. */
export class StartupAttempt {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  private readonly deadline: number;
  private readonly onStage: (stage: StartupStage) => void;
  stage: StartupStage = 'application';

  constructor(options: { timeoutMs?: number; now?: () => number; onStage?: (stage: StartupStage) => void } = {}) {
    const timeout = options.timeoutMs ?? 20_000;
    this.now = options.now ?? (() => performance.now());
    this.onStage = options.onStage ?? (() => {});
    this.deadline = this.now() + timeout;
    this.timer = setTimeout(() => this.controller.abort(new StartupError(this.stage, 'timeout')), timeout);
  }

  get signal(): AbortSignal { return this.controller.signal; }

  check(): void {
    // Also check elapsed time after synchronous work, whose execution can delay timers.
    if (!this.signal.aborted && this.now() >= this.deadline) this.controller.abort(new StartupError(this.stage, 'timeout'));
    if (this.signal.aborted) throw this.signal.reason ?? new StartupError(this.stage, 'cancelled');
  }

  setStage(stage: StartupStage): void { this.stage = stage; this.check(); this.onStage(stage); }

  wait<T>(stage: StartupStage, operation: () => T | PromiseLike<T>, disposeLate?: (value: T) => void): Promise<T> {
    this.setStage(stage);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true; this.signal.removeEventListener('abort', abort); reject(error);
      };
      const abort = () => fail(this.signal.reason ?? new StartupError(this.stage, 'cancelled'));
      this.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { this.check(); return operation(); }).then(value => {
        if (!settled) { try { this.check(); } catch (error) { fail(error); } }
        if (settled) { disposeLate?.(value); return; }
        settled = true; this.signal.removeEventListener('abort', abort); resolve(value);
      }).catch(fail);
    });
  }

  cancel(): void { this.controller.abort(new StartupError(this.stage, 'cancelled')); this.finish(); }
  finish(): void { clearTimeout(this.timer); }
}

/** Cancellable readiness polling, including cleanup on context loss or timeout. */
export function waitForReady(ready: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error?: unknown) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => stop(signal.reason ?? new StartupError('lighting', 'cancelled'));
    const check = () => {
      if (signal.aborted) { abort(); return; }
      try { if (ready()) stop(); else timer = setTimeout(check, 10); }
      catch (error) { stop(error); }
    };
    signal.addEventListener('abort', abort, { once: true });
    check();
  });
}

export function startupMessage(stage: StartupStage, error: unknown): string {
  const slow = error instanceof StartupError && error.reason === 'timeout';
  if (stage === 'application' || stage === 'renderer') {
    return slow ? 'Map scripts took too long to load. Showing a static map.'
      : 'Map scripts could not start. Showing a static map.';
  }
  if (stage === 'terrain' || stage === 'texture') {
    return slow ? 'Terrain data took too long to load. Showing a static map.'
      : 'Terrain data could not be loaded. Showing a static map.';
  }
  return slow ? 'Live lighting took too long to start. Showing a static map.'
    : 'Live lighting could not start. Showing a static map.';
}
