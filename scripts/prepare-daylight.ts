import { readFile, writeFile } from 'node:fs/promises';
import { daylightColors } from '../src/daylight.ts';

// The Python terrain exporter consumes the same model without a second port.
const url = new URL('../src/data/daylight-fallback.json', import.meta.url);
const result = JSON.stringify({ altitude: 45, ...daylightColors(45) }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(url, 'utf8') !== result) throw new Error('Run npm run prepare:daylight, then regenerate terrain.');
} else {
  await writeFile(url, result);
  console.log('Updated static fallback daylight colours. Regenerate terrain to update fallback.png.');
}
