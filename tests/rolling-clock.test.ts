import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reelsAt } from '../src/rolling-clock.ts';
import { swissParts } from '../src/time.ts';

test('rolling digits carry seconds, minutes, hours and midnight together', () => {
  const before = reelsAt(Date.parse('2026-11-03T22:59:59.950Z'), 1);
  assert.equal(before.map(reel => reel.digit).join(''), '235959');
  assert.equal(before.map(reel => reel.next).join(''), '000000');
  assert.ok(before.every(reel => reel.phase > 0));
  const after = reelsAt(Date.parse('2026-11-03T23:00:00.000Z'), 1);
  assert.equal(after.map(reel => reel.digit).join(''), '000000');
});
test('1000× reels always derive digits from current simulation time, including large jumps', () => {
  for (const epoch of [Date.parse('2026-11-03T12:34:56.789Z'), Date.parse('1900-01-01T00:00:00Z'), Date.parse('2100-12-30T23:59:59Z')]) {
    const p = swissParts(epoch);
    const expected = [p.hour,p.minute,p.second].map(value => String(value).padStart(2,'0')).join('');
    const reels = reelsAt(epoch, 1000);
    assert.equal(reels.map(reel => reel.digit).join(''), expected);
    assert.ok(reels.every(reel => reel.phase >= 0 && reel.phase <= 1));
    assert.equal(reelsAt(epoch, 10).map(reel => reel.digit).join(''), expected);
  }
});
test('snapping, paused scrubbing, and reduced motion produce stationary digits', () => {
  assert.ok(reelsAt(Date.parse('2026-11-03T12:34:56.950Z'), 1000, false).every(reel => reel.phase === 0));
});
