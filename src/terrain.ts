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

export function validateMetadata(value: unknown): TerrainMetadata {
  if (!value || typeof value !== 'object') throw new Error('Invalid terrain metadata.');
  const m = value as TerrainMetadata;
  if (m.schemaVersion !== 1 || m.crs !== 'EPSG:21781'
      || m.heightEncoding !== 'uint16-le-metres-LN02' || m.rowOrder !== 'north-to-south'
      || !Number.isInteger(m.width) || m.width < 2 || m.width > 2048
      || !Number.isInteger(m.height) || m.height < 2 || m.height > 2048
      || !Number.isFinite(m.spacingMeters) || m.spacingMeters < 100 || m.spacingMeters > 2000
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

export function decodeElevations(buffer: ArrayBuffer, metadata: TerrainMetadata): Uint16Array {
  const count = metadata.width * metadata.height;
  if (buffer.byteLength !== count * 2) throw new Error('Incomplete elevation data.');
  const view = new DataView(buffer);
  const heights = new Uint16Array(count);
  for (let index = 0; index < count; index++) {
    const height = view.getUint16(index * 2, true);
    if (height > 6000) throw new Error('Invalid elevation data.');
    heights[index] = height;
  }
  return heights;
}

/** Indexed north-first grid in kilometres: east = +X, elevation = +Y, south = +Z. */
export function terrainVertices(metadata: TerrainMetadata, heights: Uint16Array): {
  positions: Float32Array; uv: Float32Array; indices: Uint32Array;
} {
  const { width, height, spacingMeters } = metadata;
  if (heights.length !== width * height) throw new Error('Terrain dimensions do not match.');
  const step = spacingMeters / 1000;
  const positions = new Float32Array(width * height * 3);
  const uv = new Float32Array(width * height * 2);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const index = row * width + col;
      positions.set([(col - (width - 1) / 2) * step, heights[index] / 1000,
        (row - (height - 1) / 2) * step], index * 3);
      uv.set([col / (width - 1), 1 - row / (height - 1)], index * 2);
    }
  }
  const indices = new Uint32Array((width - 1) * (height - 1) * 6);
  let cursor = 0;
  for (let row = 0; row < height - 1; row++) {
    for (let col = 0; col < width - 1; col++) {
      const a = row * width + col, b = a + 1, c = a + width, d = c + 1;
      indices.set([a, c, b, b, c, d], cursor);
      cursor += 6;
    }
  }
  return { positions, uv, indices };
}
