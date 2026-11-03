import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkyModel, discOverlap, lightDirection, lunarTransmission } from '../src/astronomy.ts';
import { SearchLunarEclipse } from 'astronomy-engine';

const sky = new SkyModel();
const at = (iso: string) => sky.at(Date.parse(iso));
test('Swiss summer and winter solar elevations follow the seasons', () => {
  assert.ok(at('2026-06-21T12:00:00Z').sun.altitude > 60);
  assert.ok(at('2026-12-21T12:00:00Z').sun.altitude < 22);
  assert.ok(at('2026-12-21T12:00:00Z').sun.altitude > 17);
});
test('no direct sunlight below the horizon and continuous twilight', () => {
  const night = at('2026-06-21T00:00:00Z');
  assert.ok(night.sun.altitude < 0);
  assert.equal(night.sunStrength, 0);
  let previous = at('2026-06-21T02:00:00Z').daylight;
  for (let minutes = 1; minutes < 180; minutes++) {
    const current = sky.at(Date.parse('2026-06-21T02:00:00Z') + minutes * 60_000).daylight;
    assert.ok(current >= previous - 0.0001);
    assert.ok(Math.abs(current - previous) < 0.03);
    previous = current;
  }
});
test('moon phase affects moonlight and the Moon cannot illuminate from below the horizon', () => {
  const full = at('2026-01-03T03:00:00Z');
  const empty = at('2026-01-18T18:00:00Z');
  assert.ok(full.moonFraction > 0.98);
  assert.ok(full.moonStrength > 1);
  assert.ok(empty.moonFraction < 0.01);
  for (let h = 0; h < 24; h++) {
    const state = sky.at(Date.UTC(2026, 0, 3, h));
    if (state.moon.altitude <= 0) assert.equal(state.moonStrength, 0);
  }
});
test('solar eclipse visible from Switzerland dims the map', () => {
  const state = at('2015-03-20T09:35:00Z');
  assert.ok(state.solarObscuration > 0.6 && state.solarObscuration < 0.85);
  assert.ok(state.sunStrength < 1.1);
  assert.ok(at('2026-08-12T18:18:53Z').solarObscuration > 0.85);
});
test('an eclipse elsewhere on Earth does not dim Switzerland', () => {
  assert.equal(at('2024-04-08T18:17:00Z').solarObscuration, 0);
});
test('lunar eclipse attenuates visible moonlight, with continuous entry and exit', () => {
  const state = at('2025-09-07T18:11:00Z');
  assert.ok(state.moon.altitude > 0);
  assert.ok(state.lunarTransmission < 0.1);
  const event = SearchLunarEclipse(new Date('2025-08-01T00:00:00Z'));
  const outside = event.peak.date.getTime() + event.sd_penum * 60_000;
  assert.equal(lunarTransmission(event, outside + 1), 1);
  assert.ok(lunarTransmission(event, outside - 1000) > 0.999);
});
test('geometrical eclipse during daytime cannot create lunar light', () => {
  const state = at('2026-03-03T11:33:00Z');
  assert.ok(state.lunarTransmission < 0.1);
  assert.equal(state.moonStrength, 0);
});
test('disc overlap handles no eclipse, totality, annularity, and contact', () => {
  assert.equal(discOverlap(1, 1, 3), 0);
  assert.equal(discOverlap(1, 1.1, 0), 1);
  assert.equal(discOverlap(1, 0.5, 0), 0.25);
  assert.equal(discOverlap(1, 1, 2), 0);
  assert.ok(discOverlap(1, 1, 1) > 0 && discOverlap(1, 1, 1) < 1);
});
test('cardinal light vectors map east/right and north/up consistently', () => {
  const [east, up, south] = lightDirection(90, 30);
  assert.ok(east > 0.8);
  assert.ok(Math.abs(up - 0.5) < 1e-12);
  assert.ok(Math.abs(south) < 1e-12);
  assert.ok(lightDirection(0, 30)[2] < 0);
});
