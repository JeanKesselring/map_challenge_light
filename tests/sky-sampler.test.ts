import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkyModel } from '../src/astronomy.ts';
import { interpolateSky, SkySampler } from '../src/sky-sampler.ts';
import { SPEEDS, SimulationClock } from '../src/clock.ts';
import { paletteFor, rgb } from '../src/palette.ts';

test('lighting interpolation crosses north smoothly and gates light at the horizon', () => {
  const state = new SkyModel().at(Date.parse('2026-11-03T12:00:00Z'));
  const a = { ...state, sun: { azimuth: 359, altitude: -2 }, moon: { azimuth: 359, altitude: -4 } };
  const b = { ...state, sun: { azimuth: 1, altitude: 2 }, moon: { azimuth: 1, altitude: 2 }, moonStrength: 1 };
  const middle = interpolateSky(a,b,0.5);
  assert.equal(middle.sun.azimuth, 0);
  assert.equal(middle.sunStrength, 0);
  assert.equal(middle.moonStrength, 0);
});

test('the August 2026 eclipse stays visible through accelerated playback and date jumps', () => {
  const start = Date.parse('2026-08-12T17:00:00Z');
  const peak = Date.parse('2026-08-12T18:18:53Z');
  const exact = paletteFor(new SkyModel().at(peak));
  const sampler = new SkySampler();
  for (const speed of SPEEDS) {
    const clock = new SimulationClock(start, 0);
    clock.setSpeed(speed, 0);
    sampler.at(start, speed);
    const state = sampler.at(clock.now((peak - start) / speed), speed);
    assert.ok(state.solarObscuration > 0.9);
    const actual = rgb(paletteFor(state).background), expected = rgb(exact.background);
    assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 2 / 255));
    clock.setTime(Date.parse('2026-08-13T12:00:00Z'), 1000);
    assert.equal(sampler.at(clock.now(1000), speed).solarObscuration, 0);
  }
});
test('sampler stays aligned after speed changes and calendar jumps', () => {
  const sampler = new SkySampler(), sky = new SkyModel();
  for (const date of ['2015-03-20T09:35:00Z','2026-08-12T18:18:53Z','2026-01-03T03:00:00Z']) {
    const epoch = Date.parse(date), expected = sky.at(epoch);
    sampler.invalidate();
    for (const speed of [1,1000,10]) {
      const actual = sampler.at(epoch,speed);
      assert.ok(Math.abs(actual.sun.altitude - expected.sun.altitude) < 0.02);
      assert.ok(Math.abs(actual.solarObscuration - expected.solarObscuration) < 0.02);
    }
  }
});
