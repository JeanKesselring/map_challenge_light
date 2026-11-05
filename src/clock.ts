export const SPEEDS = [1, 1000, 10_000] as const;
export type Speed = (typeof SPEEDS)[number];
export const MIN_TIME = Date.UTC(1899, 11, 31, 23);
export const MAX_TIME = Date.UTC(2100, 11, 31, 22, 59, 59, 999);

/** Anchor against a monotonic clock so frame rate and tab suspension do not cause drift. */
export class SimulationClock {
  private epoch: number;
  private anchor: number;
  speed: Speed = 1;
  paused = false;

  constructor(epoch = Date.now(), monotonic = performance.now()) {
    this.epoch = epoch;
    this.anchor = monotonic;
  }

  now(monotonic = performance.now()): number {
    return Math.min(MAX_TIME, Math.max(MIN_TIME,
      this.epoch + (this.paused ? 0 : Math.max(0, monotonic - this.anchor) * this.speed)));
  }

  setSpeed(speed: Speed, monotonic = performance.now()): void {
    if (!SPEEDS.includes(speed)) throw new RangeError('Unsupported playback speed.');
    this.epoch = this.now(monotonic);
    this.anchor = monotonic;
    this.speed = speed;
  }

  setTime(epoch: number, monotonic = performance.now()): void {
    if (!Number.isFinite(epoch) || epoch < MIN_TIME || epoch > MAX_TIME) {
      throw new RangeError('Choose a date between 1900 and 2100.');
    }
    this.epoch = epoch;
    this.anchor = monotonic;
  }

  reset(epoch = Date.now(), monotonic = performance.now()): void {
    this.setTime(epoch, monotonic);
    this.speed = 1;
    this.paused = false;
  }

  pause(monotonic = performance.now()): void {
    this.epoch = this.now(monotonic);
    this.anchor = monotonic;
    this.paused = true;
  }

  resume(monotonic = performance.now()): void {
    if (!this.paused) return;
    this.anchor = monotonic;
    this.paused = false;
  }
}
