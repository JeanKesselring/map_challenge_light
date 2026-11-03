import { formatSwissTime, swissParts } from './time.ts';

export interface ReelState { digit: number; next: number; phase: number; }

/** Derive each reel from absolute time, including carries; there is no animation queue. */
export function reelsAt(epoch: number, speed: number, animate = true): ReelState[] {
  const p = swissParts(epoch);
  const fraction = ((epoch % 1000) + 1000) % 1000 / 1000;
  const seconds = p.hour * 3600 + p.minute * 60 + p.second + fraction;
  const text = `${String(p.hour).padStart(2, '0')}${String(p.minute).padStart(2, '0')}${String(p.second).padStart(2, '0')}`;
  const nextHour = String((p.hour + 1) % 24).padStart(2, '0');
  const nextMinute = String((p.minute + 1) % 60).padStart(2, '0');
  const nextSecond = String((p.second + 1) % 60).padStart(2, '0');
  const periods = [p.hour >= 20 ? 14400 : 36000, 3600, 600, 60, 10, 1];
  const elapsed = [p.hour >= 20 ? seconds - 72000 : seconds % 36000,
    seconds % 3600, seconds % 600, seconds % 60, seconds % 10, fraction];
  const next = [p.hour < 10 ? 1 : p.hour < 20 ? 2 : 0,
    +nextHour[1], (Math.floor(p.minute / 10) + 1) % 6,
    +nextMinute[1], (Math.floor(p.second / 10) + 1) % 6, +nextSecond[1]];
  return [...text].map((digit, i) => {
    const window = Math.min(periods[i], Math.max(0.15, 0.15 * speed));
    const t = animate ? Math.max(0, Math.min(1, (elapsed[i] - periods[i] + window) / window)) : 0;
    return { digit: +digit, next: next[i], phase: t * t * (3 - 2 * t) };
  });
}

export class RollingClock {
  private readonly time: HTMLTimeElement;
  private readonly button: HTMLButtonElement;
  private readonly strips: HTMLElement[];
  private readonly date: HTMLElement;
  private readonly readable: HTMLElement;
  private readonly zone: HTMLElement;
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private snapNext = true;
  private lastZone = '';
  private lastLabel = '';
  private lastAccessible = 0;

  constructor(time: HTMLTimeElement, button: HTMLButtonElement, zone: HTMLElement) {
    this.time = time; this.button = button;
    this.zone = zone;
    this.date = time.querySelector<HTMLElement>('.clock-date')!;
    this.readable = time.querySelector<HTMLElement>('.clock-readable')!;
    const digits = time.querySelector<HTMLElement>('.clock-digits')!;
    this.strips = Array.from({ length: 6 }, (_, i) => {
      if (i === 2 || i === 4) {
        const colon = document.createElement('span'); colon.className = 'clock-colon'; colon.textContent = ':';
        digits.append(colon);
      }
      const reel = document.createElement('span'); reel.className = 'digit-reel';
      const strip = document.createElement('span'); strip.className = 'digit-strip';
      strip.append(document.createElement('span'), document.createElement('span'));
      reel.append(strip); digits.append(reel);
      return strip;
    });
  }

  snap(): void { this.snapNext = true; }

  render(epoch: number, speed: number, paused: boolean): void {
    const p = swissParts(epoch);
    const animate = !this.snapNext && !paused && !this.motion.matches && this.lastZone === p.zone;
    const reels = reelsAt(epoch, speed, animate);
    for (let i = 0; i < this.strips.length; i++) {
      const strip = this.strips[i], state = reels[i];
      const current = strip.children[0], next = strip.children[1];
      if (current.textContent !== String(state.digit)) current.textContent = String(state.digit);
      if (next.textContent !== String(state.next)) next.textContent = String(state.next);
      strip.style.transform = `translateY(${-state.phase * 50}%)`;
    }
    const label = formatSwissTime(epoch);
    if (label.label !== this.lastLabel) {
      this.date.textContent = label.label.split(' ·')[0];
      this.zone.textContent = label.zone;
      this.lastLabel = label.label;
    }
    if (performance.now() - this.lastAccessible > 250 || this.snapNext) {
      this.time.dateTime = new Date(epoch).toISOString();
      this.readable.textContent = `${label.label} ${label.zone}`;
      this.button.setAttribute('aria-label', `Change date and time: ${label.label} ${label.zone}, Switzerland`);
      this.lastAccessible = performance.now();
    }
    this.lastZone = p.zone;
    this.snapNext = false;
  }
}
