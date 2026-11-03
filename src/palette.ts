import colors from '../palette.json' with { type: 'json' };
import type { LightState } from './astronomy.ts';
import { smoothstep } from './astronomy.ts';
import { daylightColors, linearRGBToHex } from './daylight.ts';

export interface LightingPalette {
  background: string;
  shadow: string;
  ink: string;
  accent: string;
}

export function rgb(hex: string): number[] {
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}
const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const srgb = (value: number) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

/** Mix in the same linear colour space as the visible terrain shader. */
export function mixColor(a: string, b: string, fraction: number): string {
  const left = rgb(a), right = rgb(b), t = Math.max(0, Math.min(1, fraction));
  return '#' + left.map((value, i) => Math.round(srgb(linear(value) * (1 - t) + linear(right[i]) * t) * 255)
    .toString(16).padStart(2, '0')).join('');
}

const luminance = (color: string) => rgb(color).map(linear)
  .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);

export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Near the horizon, level ground gets almost no direct sunlight, so the
// physical lit and skylight-only colours converge and the relief vanishes.
// Illustratively deepen the daylight shadow, keeping its chromaticity.
// Linear mixing with the night palette cannot fall below the lower contrast.
export const MIN_DAYLIGHT_CONTRAST = 2.2;

function deepen(shadow: string, background: string, minimum: number): string {
  const current = luminance(shadow), target = (luminance(background) + 0.05) / minimum - 0.05;
  if (current <= target) return shadow;
  const gain = Math.max(0, target) / current;
  return linearRGBToHex(rgb(shadow).map(value => linear(value) * gain));
}

export function paletteFor(state: Pick<LightState, 'sun' | 'daylight' | 'moonStrength' | 'solarObscuration'>): LightingPalette {
  const moon = Math.min(1, Math.max(0, state.moonStrength / 1.3));
  const night = mixColor(colors.night, colors.moonlight, moon);
  const daylight = daylightColors(state.sun.altitude);
  // The clear-sky/twilight model is approximate at the horizon. Fade the
  // eclipse contribution over its last degree to avoid a flash at sunset.
  const obscuration = Math.max(0, Math.min(1, state.solarObscuration)) * smoothstep(0, 1, state.sun.altitude);
  const residualSky = rgb(colors.nightShadow).map(value => linear(value) * colors.eclipseAmbientFraction);
  // Fixed clear-sky exposure: a partial eclipse loses light rather than just
  // changing the hue toward the normal (much brighter) night palette.
  const dim = (color: string) => obscuration === 0 ? color : linearRGBToHex(rgb(color)
    .map((value, i) => linear(value) * (1 - obscuration) + residualSky[i] * obscuration));
  const background = dim(mixColor(night, daylight.background, state.daylight));
  const daylightShadow = deepen(daylight.shadow, daylight.background, MIN_DAYLIGHT_CONTRAST);
  const shadow = dim(mixColor(mixColor(colors.nightShadow, colors.moonShadow, moon), daylightShadow, state.daylight));
  const darkInk = '#000000', lightInk = '#fffdf7';
  const ink = contrast(background, darkInk) >= contrast(background, lightInk) ? darkInk : lightInk;
  const preferredAccent = ink === darkInk ? '#b51e18' : '#ffd0bd';
  const accent = contrast(background, preferredAccent) >= 3 ? preferredAccent : '#590604';
  return { background, shadow, ink, accent };
}

export const FALLBACK_PALETTE = paletteFor({ sun: { altitude: 45, azimuth: 315 }, daylight: 1, moonStrength: 0, solarObscuration: 0 });

export function terrainColor(palette: LightingPalette, visibility: number): string {
  return mixColor(palette.shadow, palette.background, visibility);
}
