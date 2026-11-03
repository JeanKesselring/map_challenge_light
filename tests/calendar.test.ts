import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarInstant, monthCells, monthDays, shiftMonth } from '../src/calendar.ts';

test('calendar starts on Monday and respects leap years', () => {
  assert.equal(monthDays(2000, 2), 29);
  assert.equal(monthDays(2100, 2), 28);
  assert.equal(monthCells(2026, 6)[0], 1);
  assert.deepEqual(monthCells(2026, 11).slice(0, 7), [null, null, null, null, null, null, 1]);
  assert.equal(monthCells(2026, 11).length % 7, 0);
});
test('month navigation clamps days and remains within 1900–2100', () => {
  assert.deepEqual(shiftMonth({ year: 2026, month: 1, day: 31 }, 1), { year: 2026, month: 2, day: 28 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 12, day: 15 }, 1), { year: 2027, month: 1, day: 15 });
  assert.deepEqual(shiftMonth({ year: 1900, month: 1, day: 1 }, -1), { year: 1900, month: 1, day: 1 });
  assert.deepEqual(shiftMonth({ year: 2100, month: 12, day: 31 }, 1), { year: 2100, month: 12, day: 31 });
});
test('custom fields preserve Swiss time validation, including DST', () => {
  const autumn = calendarInstant({ year: 2026, month: 10, day: 25 }, '2', '30', '0');
  assert.equal(new Date(autumn).toISOString(), '2026-10-25T00:30:00.000Z');
  assert.throws(() => calendarInstant({ year: 2026, month: 3, day: 29 }, '02', '30', '00'), /does not exist/);
  for (const values of [['24','00','00'], ['12','60','00'], ['12','00','60'], ['','00','00'], ['-1','00','00']]) {
    assert.throws(() => calendarInstant({ year: 2026, month: 11, day: 3 }, ...values as [string,string,string]), RangeError);
  }
});
