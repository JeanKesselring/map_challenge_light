import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromSwissInput, toSwissInput } from '../src/time.ts';

test('Swiss inputs use CET in winter and CEST in summer regardless of host zone', () => {
  assert.equal(new Date(fromSwissInput('2026-01-15T12:00')).toISOString(), '2026-01-15T11:00:00.000Z');
  assert.equal(new Date(fromSwissInput('2026-07-15T12:00:21')).toISOString(), '2026-07-15T10:00:21.000Z');
});
test('reject the missing spring hour rather than silently normalising it', () => {
  assert.throws(() => fromSwissInput('2026-03-29T02:30:00'), /does not exist/);
  assert.equal(toSwissInput(fromSwissInput('2026-03-29T01:59:59')), '2026-03-29T01:59:59');
  assert.equal(new Date(fromSwissInput('2026-03-29T03:00:00')).toISOString(), '2026-03-29T01:00:00.000Z');
});
test('repeated autumn hour chooses the earlier occurrence', () => {
  assert.equal(new Date(fromSwissInput('2026-10-25T02:30:00')).toISOString(), '2026-10-25T00:30:00.000Z');
});
test('historical and future dates round-trip through the Swiss timezone', () => {
  for (const value of ['1900-01-01T00:00:00', '1942-06-01T12:00:00', '2000-02-29T12:34:56', '2100-12-31T23:59:59']) {
    assert.equal(toSwissInput(fromSwissInput(value)), value);
  }
});
test('invalid and out-of-range inputs cannot enter the simulation', () => {
  for (const value of ['', '2026-02-30T12:00', '2026-02-29T12:00', '2100-02-29T12:00',
    '2026-13-01T00:00', '2026-01-01T24:00', '1899-12-31T12:00', '2101-01-01T00:00']) {
    assert.throws(() => fromSwissInput(value), RangeError, value);
  }
});
