export interface TerrainMetadata {
  schemaVersion: number;
  width: number;
  height: number;
  spacingMeters: number;
  west: number;
  north: number;
  crs: string;
  rowOrder: string;
  heightEncoding: string;
  countryBounds: [number, number, number, number];
}

/** Elevations in metres, whichever encoding the terrain files use. */
export type Heights = Uint16Array | Float32Array;

const METRES = 'uint16-le-metres-LN02';
// Whole metres would show as terraces on gentle slopes at fine grid spacing.
const DECIMETRES = 'uint16-le-decimetres-LN02';

export function validateMetadata(value: unknown): TerrainMetadata {
  if (!value || typeof value !== 'object') throw new Error('Invalid terrain metadata.');
  const m = value as TerrainMetadata;
  if (m.schemaVersion !== 1 || m.crs !== 'EPSG:21781'
      || (m.heightEncoding !== METRES && m.heightEncoding !== DECIMETRES) || m.rowOrder !== 'north-to-south'
      || !Number.isInteger(m.width) || m.width < 2 || m.width > 2048
      || !Number.isInteger(m.height) || m.height < 2 || m.height > 2048
      || !Number.isFinite(m.spacingMeters) || m.spacingMeters < 25 || m.spacingMeters > 2000
      || !Number.isFinite(m.west) || !Number.isFinite(m.north)
      || !Array.isArray(m.countryBounds) || m.countryBounds.length !== 4
      || !m.countryBounds.every(Number.isFinite)) throw new Error('Unsupported terrain metadata.');
  const [west, south, east, north] = m.countryBounds;
  if (west >= east || south >= north || west < m.west || north > m.north
      || east > m.west + (m.width - 1) * m.spacingMeters
      || south < m.north - (m.height - 1) * m.spacingMeters) {
    throw new Error('Country bounds are outside the elevation grid.');
  }
  return m;
}

export function decodeElevations(buffer: ArrayBuffer, metadata: TerrainMetadata): Heights {
  const count = metadata.width * metadata.height;
  if (buffer.byteLength !== count * 2) throw new Error('Incomplete elevation data.');
  const view = new DataView(buffer);
  const decimetres = metadata.heightEncoding === DECIMETRES;
  const heights = decimetres ? new Float32Array(count) : new Uint16Array(count);
  for (let index = 0; index < count; index++) {
    const value = view.getUint16(index * 2, true);
    const height = decimetres ? value / 10 : value;
    if (height > 6000) throw new Error('Invalid elevation data.');
    heights[index] = height;
  }
  return heights;
}

/** Indexed north-first grid in kilometres: east = +X, elevation = +Y, south = +Z. */
export function terrainVertices(metadata: TerrainMetadata, heights: Heights): {
  positions: Float32Array; normals: Float32Array; uv: Float32Array; indices: Uint32Array;
} {
  const { width, height, spacingMeters } = metadata;
  if (heights.length !== width * height) throw new Error('Terrain dimensions do not match.');
  const step = spacingMeters / 1000;
  const positions = new Float32Array(width * height * 3);
  const normals = new Float32Array(positions.length);
  const uv = new Float32Array(width * height * 2);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const index = row * width + col;
      positions[index * 3] = (col - (width - 1) / 2) * step;
      positions[index * 3 + 1] = heights[index] / 1000;
      positions[index * 3 + 2] = (row - (height - 1) / 2) * step;
      uv[index * 2] = col / (width - 1);
      uv[index * 2 + 1] = 1 - row / (height - 1);
    }
  }
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);
  const addNormal = (vertex: number, x: number, y: number, z: number) => {
    const at = vertex * 3;
    normals[at] += x; normals[at + 1] += y; normals[at + 2] += z;
  };
  let cursor = 0;
  for (let row = 0; row < height - 1; row++) {
    for (let col = 0; col < width - 1; col++) {
      const a = row * width + col, b = a + 1, c = a + width, d = c + 1;
      indices[cursor++] = a; indices[cursor++] = c; indices[cursor++] = b;
      indices[cursor++] = b; indices[cursor++] = c; indices[cursor++] = d;
      // Accumulate the same area-weighted triangle normals as Three.js while
      // building indices. Avoid millions of temporary arrays and attribute calls.
      const dx = positions[b * 3] - positions[a * 3];
      const dz = positions[c * 3 + 2] - positions[a * 3 + 2];
      const ha = positions[a * 3 + 1], hb = positions[b * 3 + 1];
      const hc = positions[c * 3 + 1], hd = positions[d * 3 + 1];
      const nx = (ha - hb) * dz, ny = dx * dz, nz = (ha - hc) * dx;
      addNormal(a, nx, ny, nz); addNormal(c, nx, ny, nz); addNormal(b, nx, ny, nz);
      const mx = (hc - hd) * dz, mz = (hb - hd) * dx;
      addNormal(b, mx, ny, mz); addNormal(c, mx, ny, mz); addNormal(d, mx, ny, mz);
    }
  }
  for (let at = 0; at < normals.length; at += 3) {
    const length = Math.hypot(normals[at], normals[at + 1], normals[at + 2]);
    normals[at] /= length; normals[at + 1] /= length; normals[at + 2] /= length;
  }
  return { positions, normals, uv, indices };
}

/**
 * Drop grid triangles entirely outside the mask, which never paint or cast.
 * A cell survives if it, or a neighbour, holds any masked pixel: shading and
 * boundary walls still find the full roof. Expects terrainVertices' index order.
 */
export function cullOutsideMask(metadata: TerrainMetadata, indices: Uint32Array,
  mask: { width: number; height: number; data: ArrayLike<number> }): Uint32Array {
  const columns = metadata.width - 1, rows = metadata.height - 1;
  const channels = mask.data.length / (mask.width * mask.height);
  if (indices.length !== columns * rows * 6 || (channels !== 1 && channels !== 4)) {
    throw new Error('Terrain cull dimensions do not match.');
  }
  const keep = new Uint8Array(columns * rows);
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (mask.data[(y * mask.width + x) * channels] < 128) continue;
    const column = Math.floor(x * columns / mask.width), row = Math.floor(y * rows / mask.height);
    for (let r = Math.max(0, row - 1); r <= Math.min(rows - 1, row + 1); r++) {
      for (let c = Math.max(0, column - 1); c <= Math.min(columns - 1, column + 1); c++) keep[r * columns + c] = 1;
    }
  }
  const result = new Uint32Array(keep.reduce((sum, value) => sum + value, 0) * 6);
  let cursor = 0;
  for (let cell = 0; cell < keep.length; cell++) {
    if (!keep[cell]) continue;
    for (let i = 0; i < 6; i++) result[cursor++] = indices[cell * 6 + i];
  }
  return result;
}
