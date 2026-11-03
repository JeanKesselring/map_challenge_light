import { SkyModel } from './astronomy.ts';
import type { LightState } from './astronomy.ts';

export function interpolateSky(a: LightState, b: LightState, fraction: number): LightState {
  const t = Math.max(0, Math.min(1, fraction));
  const blend = (x: number, y: number) => x + (y - x) * t;
  const body = (x: LightState['sun'], y: LightState['sun']) => ({
    altitude: blend(x.altitude, y.altitude),
    azimuth: (x.azimuth + ((y.azimuth - x.azimuth + 540) % 360 - 180) * t + 360) % 360,
  });
  const sun = body(a.sun, b.sun), moon = body(a.moon, b.moon);
  return {
    sun, moon,
    sunStrength: sun.altitude > 0 ? blend(a.sunStrength, b.sunStrength) : 0,
    moonStrength: moon.altitude > 0 ? blend(a.moonStrength, b.moonStrength) : 0,
    daylight: blend(a.daylight, b.daylight),
    moonFraction: blend(a.moonFraction, b.moonFraction),
    solarObscuration: blend(a.solarObscuration, b.solarObscuration),
    lunarTransmission: blend(a.lunarTransmission, b.lunarTransmission),
  };
}

/** Cache ephemeris samples; the renderer interpolates at its own frame rate. */
export class SkySampler {
  private readonly sky = new SkyModel();
  private start = Number.NaN;
  private interval = 0;
  private left: LightState | undefined;
  private right: LightState | undefined;

  invalidate(): void { this.start = Number.NaN; }

  at(epoch: number, speed: number): LightState {
    const interval = Math.max(1000, Math.min(60_000, speed * 100));
    const start = Math.floor(epoch / interval) * interval;
    if (start !== this.start || interval !== this.interval) {
      this.left = start === this.start + this.interval && interval === this.interval
        ? this.right : this.sky.at(start);
      this.right = this.sky.at(start + interval);
      this.start = start;
      this.interval = interval;
    }
    return interpolateSky(this.left!, this.right!, (epoch - start) / interval);
  }
}
