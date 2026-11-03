import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, paletteFor, rgb, terrainColor } from '../src/palette.ts';
import { SkyModel, smoothstep } from '../src/astronomy.ts';

const luminance = (color: string) => rgb(color)
  .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);

test('fully lit terrain is exactly the page background at all times of day', () => {
  for (const daylight of [0, 0.2, 0.5, 1]) for (const altitude of [-12, 0, 1, 5, 15, 45, 70, 90]) for (const moonStrength of [0,0.3,0.8,1.3]) for (const solarObscuration of [0, 0.5, 0.94, 1]) {
    const palette = paletteFor({ daylight, sun: { altitude, azimuth: 180 }, moonStrength, solarObscuration });
    assert.equal(terrainColor(palette, 1), palette.background);
    assert.equal(terrainColor(palette, 0), palette.shadow);
    assert.ok(contrast(palette.background, palette.ink) >= 4.5);
    assert.ok(contrast(palette.background, palette.accent) >= 3);
  }
});
test('moonless nights and the deepest shadows remain visibly blue', () => {
  const palette = paletteFor({ daylight: 0, sun: { altitude: -20, azimuth: 180 }, moonStrength: 0, solarObscuration: 0 });
  assert.equal(palette.background, '#365d90');
  assert.equal(palette.shadow, '#214370');
  for (const color of [palette.background, palette.shadow]) {
    const [r, g, b] = rgb(color);
    assert.ok(b > g && g > r && r > 0.1);
  }
  assert.equal(paletteFor({ daylight: 0, sun: { altitude: -20, azimuth: 180 }, moonStrength: 1.3, solarObscuration: 0 }).background, '#89add2');
});

test('eclipse dimming survives daylight exposure and final palette conversion', () => {
  const sky = new SkyModel();
  for (const date of ['1999-08-11T10:30:00Z', '2015-03-20T09:35:00Z', '2026-08-12T18:18:53Z']) {
    const state = sky.at(Date.parse(date));
    assert.equal(state.daylight, smoothstep(-12, 4, state.sun.altitude), 'twilight and eclipse attenuation stay separate');
    const eclipsed = paletteFor(state), clear = paletteFor({ ...state, solarObscuration: 0 });
    const remaining = 1 - state.solarObscuration;
    assert.ok(luminance(eclipsed.background) < luminance(clear.background) * (remaining + 0.03));
    assert.ok(luminance(eclipsed.shadow) < luminance(clear.shadow));
  }
});

test('total eclipse retains blue residual light and distant eclipses cannot dim the map', () => {
  const sky = new SkyModel();
  const state = sky.at(Date.parse('2015-03-20T09:35:00Z'));
  const total = paletteFor({ ...state, solarObscuration: 1 });
  const [r, g, b] = rgb(total.background);
  assert.ok(b > g && g > r && r > 0.01);
  assert.ok(luminance(total.background) < 0.02);
  const distant = sky.at(Date.parse('2024-04-08T18:17:00Z'));
  assert.deepEqual(paletteFor(distant), paletteFor({ ...distant, solarObscuration: 0 }));
});

test('the evening eclipse does not flash back to full brightness at sunset', () => {
  const sky = new SkyModel();
  const start = Date.parse('2026-08-12T18:35:00Z');
  let previous = rgb(paletteFor(sky.at(start)).background);
  for (let seconds = 1; seconds <= 600; seconds++) {
    const current = rgb(paletteFor(sky.at(start + seconds * 1000)).background);
    assert.ok(current.every((value, i) => Math.abs(value - previous[i]) <= 2 / 255));
    previous = current;
  }
});
