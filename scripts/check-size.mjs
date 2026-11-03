import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeElevations, validateMetadata } from '../src/terrain.ts';

const root = pathToFileURL(resolve(process.argv[2] ?? 'dist') + sep);
const required = ['terrain/metadata.json', 'terrain/elevation.bin', 'terrain/mask.png', 'terrain/fallback.png', 'science-notice.txt'];
for (const name of required) {
  try { await stat(new URL(name, root)); }
  catch { throw new Error(`Missing production asset ${name}. Restore public assets; regenerate terrain with uv run scripts/prepare_terrain.py if needed.`); }
}
const metadata = validateMetadata(JSON.parse(await readFile(new URL('terrain/metadata.json', root), 'utf8')));
const heights = await readFile(new URL('terrain/elevation.bin', root));
decodeElevations(heights.buffer.slice(heights.byteOffset, heights.byteOffset + heights.byteLength), metadata);
const html = await readFile(new URL('index.html', root), 'utf8');
for (const [, path] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (path.startsWith('/')) throw new Error(`Absolute asset URL is incompatible with repository hosting: ${path}`);
}
async function compressedSize(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    bytes += entry.isDirectory() ? await compressedSize(path) : gzipSync(await readFile(path)).length;
  }
  return bytes;
}
const bytes = await compressedSize(fileURLToPath(root));
console.log(`Compressed static site: ${(bytes / 1_000_000).toFixed(2)} MB / 5.00 MB`);
if (bytes > 5_000_000) throw new Error('The static site exceeds the 5 MB download budget.');
