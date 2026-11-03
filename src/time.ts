import { MAX_TIME, MIN_TIME } from './clock.ts';

export const TIME_ZONE = 'Europe/Zurich';
const fields = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const display = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const zone = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, timeZoneName: 'short' });

function localParts(epoch: number): Record<string, string> {
  return Object.fromEntries(fields.formatToParts(epoch).map(part => [part.type, part.value]));
}

export function swissParts(epoch: number): {
  year: number; month: number; day: number; hour: number; minute: number; second: number; zone: string;
} {
  const p = localParts(epoch);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour,
    minute: +p.minute, second: +p.second,
    zone: zone.formatToParts(epoch).find(part => part.type === 'timeZoneName')?.value ?? 'Swiss time' };
}

export function toSwissInput(epoch: number): string {
  const p = localParts(epoch);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export function formatSwissTime(epoch: number): { label: string; zone: string } {
  return {
    label: display.format(epoch).replace(',', ' ·'),
    zone: zone.formatToParts(epoch).find(part => part.type === 'timeZoneName')?.value ?? 'Swiss time',
  };
}

/** Find valid UTC candidates rather than letting the host timezone normalise DST gaps. */
export function fromSwissInput(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new RangeError('Enter a complete date and time.');
  const [, year, month, day, hour, minute, second = '00'] = match;
  const wall = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const normalised = new Date(wall).toISOString().slice(0, 19);
  const target = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  if (+year < 1900 || +year > 2100 || normalised !== target) {
    throw new RangeError('Choose a valid date between 1900 and 2100.');
  }

  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = wall + delta * 3_600_000;
    const p = localParts(probe);
    offsets.add(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - probe);
  }
  const candidates = [...offsets].map(offset => wall - offset)
    .filter(epoch => epoch >= MIN_TIME && epoch <= MAX_TIME && toSwissInput(epoch) === target);
  if (!candidates.length) {
    throw new RangeError('This time does not exist in Switzerland because the clocks move forward.');
  }
  return Math.min(...candidates);
}
