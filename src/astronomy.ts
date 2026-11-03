import {
  Body, Equator, Horizon, Illumination, NextLunarEclipse, Observer, SearchLunarEclipse,
} from 'astronomy-engine';
import type { LunarEclipseInfo } from 'astronomy-engine';

const OBSERVER = new Observer(46.8, 8.2, 500);
const RAD = Math.PI / 180;
const AU_KM = 149_597_870.7;

export interface LightState {
  sun: { azimuth: number; altitude: number };
  moon: { azimuth: number; altitude: number };
  sunStrength: number;
  moonStrength: number;
  daylight: number;
  moonFraction: number;
  solarObscuration: number;
  lunarTransmission: number;
}

export function smoothstep(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** Fraction of the Sun's disc obscured; angular radii and separation use radians. */
export function discOverlap(sunRadius: number, moonRadius: number, separation: number): number {
  if (separation >= sunRadius + moonRadius) return 0;
  if (separation <= Math.abs(sunRadius - moonRadius)) {
    return Math.min(1, (moonRadius / sunRadius) ** 2);
  }
  const d = separation, r = sunRadius, R = moonRadius;
  const clamp = (x: number) => Math.max(-1, Math.min(1, x));
  const area = r * r * Math.acos(clamp((d * d + r * r - R * R) / (2 * d * r)))
    + R * R * Math.acos(clamp((d * d + R * R - r * r) / (2 * d * R)))
    - 0.5 * Math.sqrt(Math.max(0, (-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)));
  return Math.max(0, Math.min(1, area / (Math.PI * r * r)));
}

export function lunarTransmission(event: LunarEclipseInfo, epoch: number): number {
  const minutes = Math.abs(epoch - event.peak.date.getTime()) / 60_000;
  if (minutes >= event.sd_penum) return 1;
  const penumbra = 1 - smoothstep(event.sd_partial, event.sd_penum, minutes);
  const umbra = event.sd_partial > 0
    ? 1 - smoothstep(event.sd_total, event.sd_partial, minutes) : 0;
  return Math.max(0.02, (1 - 0.18 * penumbra) * (1 - 0.97 * event.obscuration * umbra));
}

export class SkyModel {
  private year = Number.NaN;
  private lunarEclipses: LunarEclipseInfo[] = [];

  private eclipses(date: Date): void {
    const year = date.getUTCFullYear();
    if (year === this.year) return;
    const start = new Date(Date.UTC(year, 0, 1) - 86_400_000);
    const end = Date.UTC(year + 1, 0, 2);
    this.lunarEclipses = [];
    let event = SearchLunarEclipse(start);
    // A bounded cache includes both year boundaries; never search in the rendering loop.
    for (let count = 0; count < 8 && event.peak.date.getTime() < end; count++) {
      this.lunarEclipses.push(event);
      event = NextLunarEclipse(event.peak);
    }
    this.year = year;
  }

  at(epoch: number): LightState {
    const date = new Date(epoch);
    this.eclipses(date);
    const sunEq = Equator(Body.Sun, date, OBSERVER, true, true);
    const moonEq = Equator(Body.Moon, date, OBSERVER, true, true);
    const sun = Horizon(date, OBSERVER, sunEq.ra, sunEq.dec, 'normal');
    const moon = Horizon(date, OBSERVER, moonEq.ra, moonEq.dec, 'normal');
    const cosine = Math.sin(sunEq.dec * RAD) * Math.sin(moonEq.dec * RAD)
      + Math.cos(sunEq.dec * RAD) * Math.cos(moonEq.dec * RAD)
      * Math.cos((sunEq.ra - moonEq.ra) * 15 * RAD);
    const separation = Math.acos(Math.max(-1, Math.min(1, cosine)));
    const solarObscuration = sun.altitude > 0
      ? discOverlap(Math.asin(695_700 / (sunEq.dist * AU_KM)),
        Math.asin(1_737.4 / (moonEq.dist * AU_KM)), separation) : 0;
    const transmission = this.lunarEclipses.reduce(
      (value, event) => Math.min(value, lunarTransmission(event, epoch)), 1);
    const moonFraction = Illumination(Body.Moon, date).phase_fraction;
    // Twilight is independent of an eclipse. Apply occultation after display
    // exposure so the renderer cannot normalise the lost sunlight back up.
    const daylight = smoothstep(-12, 4, sun.altitude);
    return {
      sun, moon, daylight, moonFraction, solarObscuration, lunarTransmission: transmission,
      sunStrength: sun.altitude > 0
        ? smoothstep(0, 5, sun.altitude) * (1 - solarObscuration) * 2.6 : 0,
      // Moonlight ends by sunrise: level ground gets so little of a low Sun
      // that any residual moonlight would wash out its long shadows.
      moonStrength: moon.altitude > 0
        ? smoothstep(0, 12, moon.altitude) * moonFraction * transmission
          * (1 - smoothstep(-6, 0, sun.altitude)) * 1.3 : 0,
    };
  }
}

/** Elevation of the illustrative afterglow light; real twilight has no direction. */
export const TWILIGHT_ALTITUDE = 10;

/**
 * Shadowless glow from the Sun's azimuth while it is just below the horizon.
 * It replaces the fading direct beam so relief stays legible through civil
 * and nautical twilight; it is illustrative, not a twilight radiance model.
 */
export function twilightStrength(sunAltitude: number): number {
  return smoothstep(-12, -2, sunAltitude) * (1 - smoothstep(-1, 1, sunAltitude));
}

/** East, up, south: Three.js coordinates for a north-up map with +Y elevation. */
export function lightDirection(azimuth: number, altitude: number): [number, number, number] {
  const az = azimuth * RAD, alt = altitude * RAD;
  return [Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)];
}
