import { MAX_TIME, MIN_TIME, SimulationClock } from './clock.ts';
import { formatSwissTime, fromSwissInput, swissParts, toSwissInput } from './time.ts';

export const HOUR = 3_600_000;
export const WHEEL_IDLE = 150;
const QUARTER = HOUR / 4;
export const clampTime = (epoch: number) => Math.max(MIN_TIME, Math.min(MAX_TIME, epoch));

export interface TimelineTick { epoch: number; major: boolean; label: string; date: string; }

export function timelineTicks(anchor: number, hours: number): TimelineTick[] {
  const result: TimelineTick[] = [];
  for (let t = anchor - (hours / 2 + 2) * HOUR; t <= anchor + (hours / 2 + 2) * HOUR; t += QUARTER) {
    if (t < MIN_TIME || t > MAX_TIME) continue;
    const p = swissParts(t);
    const major = p.minute === 0;
    // Include offset abbreviations only when an hour repeats across the autumn change.
    const repeated = major && (swissParts(t - HOUR).hour === p.hour || swissParts(t + HOUR).hour === p.hour);
    result.push({ epoch: t, major,
      label: major ? `${String(p.hour).padStart(2, '0')}${repeated ? ` ${p.zone}` : ''}` : '',
      date: major && p.hour === 0 ? `${String(p.day).padStart(2, '0')}.${String(p.month).padStart(2, '0')}` : '',
    });
  }
  return result;
}

/** Hold an instant during a gesture while retaining the user's playback speed. */
export class ScrubSession {
  private origin: number | undefined;
  private readonly clock: SimulationClock;
  constructor(clock: SimulationClock) { this.clock = clock; }
  get active(): boolean { return this.origin !== undefined; }
  begin(monotonic = performance.now()): number {
    if (!this.active) { this.clock.pause(monotonic); this.origin = this.clock.now(monotonic); }
    return this.origin!;
  }
  seek(epoch: number, monotonic = performance.now()): void {
    this.begin(monotonic);
    this.clock.setTime(clampTime(epoch), monotonic);
  }
  end(monotonic = performance.now(), cancel = false): void {
    if (!this.active) return;
    if (cancel) this.clock.setTime(this.origin!, monotonic);
    this.origin = undefined;
    this.clock.resume(monotonic);
  }
}

export class Timeline {
  private readonly element: HTMLElement;
  private readonly clock: SimulationClock;
  private readonly changed: () => void;
  private readonly scrub: ScrubSession;
  private readonly ticks: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly events = new AbortController();
  private pixelsPerHour = 80;
  private anchor = Number.NaN;
  private hours = 12;
  private width = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | undefined;
  private pointer: { id: number; x: number; epoch: number; moved: boolean } | undefined;
  private disabled = false;
  private lastAria = -Infinity;

  constructor(element: HTMLElement, clock: SimulationClock, changed: () => void) {
    this.element = element; this.clock = clock; this.changed = changed;
    this.scrub = new ScrubSession(clock);
    element.setAttribute('aria-valuemin', String(MIN_TIME));
    element.setAttribute('aria-valuemax', String(MAX_TIME));
    this.ticks = element.querySelector<HTMLElement>('.ruler-ticks')!;
    const options = { signal: this.events.signal };
    this.observer = new ResizeObserver(() => {
      this.width = element.clientWidth;
      this.hours = window.innerWidth <= 700 ? 6 : 12;
      this.pixelsPerHour = Math.max(1, this.width) / this.hours;
      this.anchor = Number.NaN;
      this.render(this.clock.now());
    });
    this.observer.observe(element);
    element.addEventListener('pointerdown', event => {
      if (this.disabled || event.button !== 0) return;
      this.finish();
      element.focus({ preventScroll: true });
      this.pointer = { id: event.pointerId, x: event.clientX, epoch: this.scrub.begin(), moved: false };
      element.setPointerCapture(event.pointerId);
      element.classList.add('is-scrubbing');
    }, options);
    element.addEventListener('pointermove', event => {
      if (!this.pointer || event.pointerId !== this.pointer.id) return;
      const distance = event.clientX - this.pointer.x;
      if (Math.abs(distance) > 3) this.pointer.moved = true;
      if (this.pointer.moved) this.seek(this.pointer.epoch - distance / this.pixelsPerHour * HOUR);
    }, options);
    element.addEventListener('pointerup', event => {
      if (!this.pointer || event.pointerId !== this.pointer.id) return;
      if (!this.pointer.moved) {
        const box = element.getBoundingClientRect();
        this.seek(this.pointer.epoch + (event.clientX - box.left - box.width / 2) / this.pixelsPerHour * HOUR);
      }
      this.pointer = undefined;
      this.finish();
    }, options);
    const cancel = () => { this.pointer = undefined; this.finish(true); };
    element.addEventListener('pointercancel', cancel, options);
    element.addEventListener('lostpointercapture', () => { if (this.pointer) cancel(); }, options);
    element.addEventListener('wheel', event => {
      if (this.disabled || event.ctrlKey || this.pointer) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.width : 1;
      this.scrub.begin();
      this.seek(this.clock.now() + (event.deltaX || event.deltaY) * scale / this.pixelsPerHour * HOUR);
      clearTimeout(this.wheelTimer);
      this.wheelTimer = setTimeout(() => this.finish(), WHEEL_IDLE);
      element.classList.add('is-scrubbing');
    }, { ...options, passive: false });
    element.addEventListener('keydown', event => {
      if (this.disabled) return;
      const current = clock.now();
      let target: number;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        target = current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? HOUR : QUARTER);
      } else if (event.key === 'PageUp' || event.key === 'PageDown') {
        target = current + (event.key === 'PageUp' ? -24 : 24) * HOUR;
      } else if (event.key === 'Home' || event.key === 'End') {
        target = fromSwissInput(toSwissInput(current).slice(0, 10) + (event.key === 'Home' ? 'T00:00:00' : 'T23:59:59'));
      } else if (event.key === 'Escape' && this.scrub.active) {
        event.preventDefault(); this.finish(true); return;
      } else return;
      event.preventDefault(); this.seek(target); this.finish();
    }, options);
  }

  private seek(epoch: number): void {
    this.scrub.seek(epoch);
    this.changed();
    this.render(this.clock.now());
  }

  finish(cancel = false): void {
    const pointer = this.pointer;
    this.pointer = undefined;
    if (pointer && this.element.hasPointerCapture(pointer.id)) this.element.releasePointerCapture(pointer.id);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = undefined;
    this.scrub.end(performance.now(), cancel);
    this.element.classList.remove('is-scrubbing');
    if (cancel) this.changed();
  }

  render(epoch: number): void {
    const anchor = Math.floor(epoch / HOUR) * HOUR;
    if (anchor !== this.anchor) {
      this.anchor = anchor;
      const fragment = document.createDocumentFragment();
      for (const tick of timelineTicks(anchor, this.hours)) {
        const mark = document.createElement('span');
        mark.className = `ruler-tick${tick.major ? ' major' : ''}`;
        mark.style.left = `${(tick.epoch - anchor) / HOUR * this.pixelsPerHour}px`;
        if (tick.major) {
          const label = document.createElement('span'); label.className = 'tick-label'; label.textContent = tick.label;
          mark.append(label);
          if (tick.date) { const date = document.createElement('span'); date.className = 'tick-date'; date.textContent = tick.date; mark.append(date); }
        }
        fragment.append(mark);
      }
      this.ticks.replaceChildren(fragment);
    }
    this.ticks.style.transform = `translateX(${(anchor - epoch) / HOUR * this.pixelsPerHour}px)`;
    if (performance.now() - this.lastAria > 250 || this.scrub.active) {
      this.element.setAttribute('aria-valuenow', String(Math.round(epoch)));
      const value = formatSwissTime(epoch);
      this.element.setAttribute('aria-valuetext', `${value.label} ${value.zone}`);
      this.lastAria = performance.now();
    }
  }

  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    this.element.setAttribute('aria-disabled', String(disabled));
    this.element.tabIndex = disabled ? -1 : 0;
    if (disabled) this.finish();
  }

  dispose(): void { this.finish(); this.events.abort(); this.observer.disconnect(); }
}
