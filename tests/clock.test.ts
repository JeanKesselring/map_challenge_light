import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIME, MIN_TIME, SimulationClock, SPEEDS } from '../src/clock.ts';

const epoch = Date.parse('2026-11-03T12:00:00Z');
for (const speed of SPEEDS) test(`clock advances at ${speed}× regardless of frame rate`, () => {
  const clock = new SimulationClock(epoch, 100);
  clock.setSpeed(speed, 100);
  assert.equal(clock.now(5100), epoch + 5000 * speed);
});
test('changing speed preserves the displayed instant', () => {
  const clock = new SimulationClock(epoch, 0);
  clock.setSpeed(1000, 1000);
  assert.equal(clock.now(1000), epoch + 1000);
  assert.equal(clock.now(2000), epoch + 1_001_000);
  clock.setSpeed(10_000, 2000);
  assert.equal(clock.now(3000), epoch + 11_001_000);
});
test('date selection changes time without changing speed', () => {
  const clock = new SimulationClock(epoch, 0);
  clock.setSpeed(10_000, 100);
  clock.setTime(epoch + 86_400_000, 1000);
  assert.equal(clock.now(2000), epoch + 96_400_000);
  assert.equal(clock.speed, 10_000);
});
test('Now resets both instant and playback speed', () => {
  const clock = new SimulationClock(epoch, 0);
  clock.setSpeed(1000, 0);
  clock.reset(epoch + 5000, 3000);
  assert.equal(clock.speed, 1);
  assert.equal(clock.now(4000), epoch + 6000);
});
test('tab suspension catches up using elapsed monotonic time', () => {
  const clock = new SimulationClock(epoch, 10);
  clock.setSpeed(10_000, 10);
  assert.equal(clock.now(3_600_010), epoch + 36_000_000_000);
});
test('clock is bounded by the supported Swiss calendar range', () => {
  const clock = new SimulationClock(MAX_TIME - 100, 0);
  assert.equal(clock.now(1000), MAX_TIME);
  assert.throws(() => clock.setTime(MIN_TIME - 1, 0), RangeError);
  assert.throws(() => clock.setTime(Number.NaN, 0), RangeError);
  assert.throws(() => clock.setSpeed(7 as 1, 0), RangeError);
});
test('scrubbing holds time and resumes the selected speed without counting the pause', () => {
  const clock = new SimulationClock(epoch, 0);
  clock.setSpeed(1000, 0);
  clock.pause(100);
  assert.equal(clock.now(5000), epoch + 100_000);
  clock.setTime(epoch + 3_600_000, 5000);
  assert.equal(clock.now(9000), epoch + 3_600_000);
  clock.resume(9000);
  assert.equal(clock.now(9100), epoch + 3_700_000);
});
test('changing speed during a pause preserves the held instant and Now clears the pause', () => {
  const clock = new SimulationClock(epoch, 0);
  clock.pause(100);
  clock.setSpeed(10_000, 1000);
  assert.equal(clock.now(5000), epoch + 100);
  clock.reset(epoch + 1000, 6000);
  assert.equal(clock.paused, false);
  assert.equal(clock.now(7000), epoch + 2000);
});
