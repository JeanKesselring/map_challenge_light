import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeElevations, terrainVertices, validateMetadata } from '../src/terrain.ts';
import { BufferAttribute, BufferGeometry } from 'three';

const metadata = {
  schemaVersion: 1, width: 3, height: 3, spacingMeters: 400, west: 600000, north: 200000,
  crs: 'EPSG:21781', rowOrder: 'north-to-south', heightEncoding: 'uint16-le-metres-LN02',
  countryBounds: [600000, 199200, 600800, 200000] as [number, number, number, number],
};
test('terrain decoding uses explicit little endian and rejects incomplete or impossible heights', () => {
  const buffer = new ArrayBuffer(18), view = new DataView(buffer);
  for (let i = 0; i < 9; i++) view.setUint16(i * 2, 1234, true);
  assert.equal(decodeElevations(buffer, metadata)[0], 1234);
  assert.throws(() => decodeElevations(new ArrayBuffer(8), metadata), /Incomplete/);
  view.setUint16(0, 65000, true);
  assert.throws(() => decodeElevations(buffer, metadata), /Invalid/);
});
test('north-first elevations and UVs preserve map orientation without exaggeration', () => {
  const heights = new Uint16Array([100,100,100,100,1000,100,100,100,100]);
  const grid = terrainVertices(metadata, heights);
  assert.equal(grid.positions[4 * 3 + 1], 1);
  assert.ok(grid.positions[0] < 0 && grid.positions[2] < 0);
  assert.equal(grid.uv[1], 1);
  assert.equal(grid.uv[8 * 2 + 1], 0);
  assert.equal(grid.indices.length, 24);
  const [a,b,c] = grid.indices;
  const ax = grid.positions[b*3]-grid.positions[a*3], az = grid.positions[b*3+2]-grid.positions[a*3+2];
  const bx = grid.positions[c*3]-grid.positions[a*3], bz = grid.positions[c*3+2]-grid.positions[a*3+2];
  assert.ok(az*bx-ax*bz > 0, 'surface normals face upwards');
});
test('terrain metadata rejects invalid bounds, encodings, and oversized grids', () => {
  assert.deepEqual(validateMetadata(metadata), metadata);
  assert.throws(() => validateMetadata({...metadata, width: 999999}));
  assert.throws(() => validateMetadata({...metadata, crs: 'EPSG:4326'}));
  assert.throws(() => validateMetadata({...metadata, countryBounds: [0,0,1,1]}));
});

test('prepared grid normals match Three.js area-weighted normals, including edges', () => {
  const heights = new Uint16Array([100,700,200,400,1800,300,50,900,150]);
  const grid = terrainVertices(metadata, heights);
  const reference = new BufferGeometry();
  reference.setAttribute('position', new BufferAttribute(grid.positions, 3));
  reference.setIndex(new BufferAttribute(grid.indices, 1));
  reference.computeVertexNormals();
  try {
    const expected = reference.getAttribute('normal');
    for (let i = 0; i < heights.length; i++) {
      assert.ok(Math.abs(grid.normals[i * 3] - expected.getX(i)) < 0.000001);
      assert.ok(Math.abs(grid.normals[i * 3 + 1] - expected.getY(i)) < 0.000001);
      assert.ok(Math.abs(grid.normals[i * 3 + 2] - expected.getZ(i)) < 0.000001);
    }
  } finally { reference.dispose(); }
});
