import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIME, MIN_TIME, SimulationClock } from '../src/clock.ts';
import { HOUR, ScrubSession, timelineTicks } from '../src/timeline.ts';
import { swissParts } from '../src/time.ts';

test('scrub freezes playback, changes the instant, then resumes at the selected speed', () => {
  const epoch = Date.parse('2026-11-03T12:00:00Z');
  const clock = new SimulationClock(epoch, 0), scrub = new ScrubSession(clock);
  clock.setSpeed(1000, 0);
  scrub.begin(10); assert.equal(scrub.active, true);
  scrub.seek(epoch + HOUR, 100);
  assert.equal(clock.now(10000), epoch + HOUR);
  scrub.end(10000);
  assert.equal(clock.now(10100), epoch + HOUR + 100000);
  assert.equal(clock.speed, 1000); assert.equal(scrub.active, false);
});
test('cancel returns to the gesture origin and all seeks respect supported bounds', () => {
  const epoch = Date.parse('2026-11-03T12:00:00Z');
  const clock = new SimulationClock(epoch, 0), scrub = new ScrubSession(clock);
  const origin = scrub.begin(100);
  scrub.seek(MAX_TIME + HOUR, 200); assert.equal(clock.now(300), MAX_TIME);
  scrub.seek(MIN_TIME - HOUR, 300); assert.equal(clock.now(400), MIN_TIME);
  scrub.end(500, true); assert.equal(clock.now(500), origin);
  assert.equal(clock.now(600), origin + 100);
});
test('UTC ruler ticks skip the nonexistent Swiss spring hour', () => {
  const ticks = timelineTicks(Date.parse('2026-03-29T01:00:00Z'), 6);
  const major = ticks.filter(tick => tick.major && swissParts(tick.epoch).day === 29);
  assert.ok(major.some(tick => tick.label === '01'));
  assert.ok(major.some(tick => tick.label === '03'));
  assert.ok(!major.some(tick => tick.label.startsWith('02')));
});
test('repeated autumn hours have distinct zone labels at consecutive instants', () => {
  const ticks = timelineTicks(Date.parse('2026-10-25T01:00:00Z'), 6);
  const repeated = ticks.filter(tick => tick.major && tick.label.startsWith('02'));
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0].label, repeated[1].label);
  assert.equal(repeated[1].epoch - repeated[0].epoch, HOUR);
});
test('the ruler spans midnight without a jump and limits its generated ticks', () => {
  const ticks = timelineTicks(Date.parse('2026-11-03T23:00:00Z'), 12);
  assert.ok(ticks.some(tick => tick.date === '04.11'));
  assert.ok(ticks.length < 100);
  for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i].epoch - ticks[i - 1].epoch, HOUR / 4);
  assert.ok(timelineTicks(MAX_TIME, 12).every(tick => tick.epoch <= MAX_TIME));
  assert.ok(timelineTicks(MIN_TIME, 12).every(tick => tick.epoch >= MIN_TIME));
});
