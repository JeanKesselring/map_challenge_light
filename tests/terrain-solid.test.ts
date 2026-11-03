import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial,
  NearestFilter, Raycaster, Texture, Vector3 } from 'three';
import { TerrainSolid } from '../src/terrain-solid.ts';
import { terrainVertices } from '../src/terrain.ts';

const metadata = {
  schemaVersion: 1, width: 3, height: 3, spacingMeters: 1000, west: 0, north: 2000,
  crs: 'EPSG:21781', rowOrder: 'north-to-south', heightEncoding: 'uint16-le-metres-LN02',
  countryBounds: [0, 0, 2000, 2000] as [number, number, number, number],
};
const mask = { width: 3, height: 3, data: new Uint8Array([0,0,0,0,255,0,0,0,0]) };

function roof(heights: Uint16Array): Mesh<BufferGeometry, MeshBasicMaterial> {
  const grid = terrainVertices(metadata, heights), geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(grid.positions, 3));
  geometry.setIndex(new BufferAttribute(grid.indices, 1));
  return new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
}

test('extrusion blocks grazing light that passes beneath the original terrain shell', () => {
  const heights = new Uint16Array(9).fill(1000), texture = new Texture();
  const solid = new TerrainSolid(metadata, heights, texture, mask), shell = roof(heights);
  solid.updateMatrixWorld(); shell.updateMatrixWorld();
  try {
    for (const [x, z] of [[1,0], [-1,0], [0,1], [0,-1]]) for (const elevation of [0.05, 0.5, 0.9]) {
      const point = new Vector3(x * 0.5, elevation, z * 0.5);
      const direction = new Vector3(-x, Math.tan(Math.PI / 180), -z).normalize();
      const ray = new Raycaster(point, direction);
      assert.equal(ray.intersectObject(shell).length, 0, 'an open shell leaks this light');
      assert.ok(ray.intersectObject(solid, true).length > 0, 'the vertical extrusion blocks it');
    }
    assert.equal(new Raycaster(new Vector3(0.5, 1.01, 0), new Vector3(-1, 0.01, 0).normalize())
      .intersectObject(solid, true).length, 0, 'light above the terrain remains unobstructed');
  } finally { solid.dispose(); shell.geometry.dispose(); shell.material.dispose(); texture.dispose(); }
});

test('wall tops follow roof triangles exactly across grid and diagonal crossings', () => {
  const heights = new Uint16Array([100,350,200,700,2000,400,200,600,100]), texture = new Texture();
  const solid = new TerrainSolid(metadata, heights, texture, mask), shell = roof(heights);
  const walls = solid.getObjectByName('terrain-walls') as Mesh<BufferGeometry>;
  const positions = walls.geometry.getAttribute('position'), indices = walls.geometry.index!;
  shell.updateMatrixWorld();
  let checked = 0;
  try {
    for (let triangle = 0; triangle < indices.count; triangle += 3) {
      const face = [indices.getX(triangle), indices.getX(triangle + 1), indices.getX(triangle + 2)];
      for (let edge = 0; edge < 3; edge++) {
        const a = face[edge], b = face[(edge + 1) % 3];
        if (positions.getY(a) <= 0 || positions.getY(b) <= 0) continue;
        const midpoint = new Vector3().fromBufferAttribute(positions, a)
          .add(new Vector3().fromBufferAttribute(positions, b)).multiplyScalar(0.5);
        const hits = new Raycaster(new Vector3(midpoint.x, 10, midpoint.z), new Vector3(0, -1, 0)).intersectObject(shell);
        assert.ok(hits.length > 0);
        assert.ok(Math.abs(hits[0].point.y - midpoint.y) < 0.000002, 'no roof-to-wall seam');
        checked++;
      }
    }
    assert.ok(checked >= 8, 'walls split where their top changes roof triangle');
  } finally { solid.dispose(); shell.geometry.dispose(); shell.material.dispose(); texture.dispose(); }
});

test('enclaves have inward-facing boundary walls as well as the outer extrusion', () => {
  const texture = new Texture(), data = new Uint8Array(9).fill(255);
  data[4] = 0;
  const solid = new TerrainSolid(metadata, new Uint16Array(9).fill(1000), texture, { ...mask, data });
  const walls = solid.getObjectByName('terrain-walls')!;
  solid.updateMatrixWorld();
  try {
    for (const [x, z] of [[1,0], [-1,0], [0,1], [0,-1]]) {
      const hit = new Raycaster(new Vector3(0, 0.2, 0), new Vector3(x, 0, z)).intersectObject(walls)[0];
      assert.ok(hit);
      assert.ok(Math.abs(hit.distance - 1 / 3) < 0.000001);
    }
  } finally { solid.dispose(); texture.dispose(); }
});

test('RGBA mask rows keep northern extrusion walls on the north side', () => {
  const texture = new Texture();
  const rgba = new Uint8ClampedArray([0,0,0,255, 255,255,255,255, 0,0,0,255, 0,0,0,255]);
  const solid = new TerrainSolid(metadata, new Uint16Array(9).fill(1000), texture,
    { width: 2, height: 2, data: rgba });
  const walls = solid.getObjectByName('terrain-walls')!;
  solid.updateMatrixWorld();
  try {
    const north = new Raycaster(new Vector3(0.5, 0.2, -1.2), new Vector3(0, 0, 1)).intersectObject(walls)[0];
    const south = new Raycaster(new Vector3(0.5, 0.2, 1.2), new Vector3(0, 0, -1)).intersectObject(walls)[0];
    assert.ok(Math.abs(north.distance - 0.2) < 0.000001);
    assert.ok(Math.abs(south.distance - 1.2) < 0.000001);
    assert.equal(new Raycaster(new Vector3(-0.5, 0.2, -1.2), new Vector3(0, 0, 1)).intersectObject(walls).length, 0);
  } finally { solid.dispose(); texture.dispose(); }
});

test('walls and base cast without painting the map, using an identical mask footprint', () => {
  const texture = new Texture();
  const solid = new TerrainSolid(metadata, new Uint16Array(9).fill(1000), texture, mask);
  try {
    for (const child of solid.children) {
      const mesh = child as Mesh<BufferGeometry, MeshBasicMaterial>;
      assert.equal(mesh.castShadow, true);
      assert.equal(mesh.material.colorWrite, false);
      assert.equal(mesh.material.depthWrite, false);
      assert.equal(mesh.material.shadowSide, DoubleSide);
    }
    const base = solid.getObjectByName('terrain-base') as Mesh<BufferGeometry, MeshBasicMaterial>;
    assert.equal(base.material.alphaMap, texture);
    assert.equal(base.material.alphaTest, 0.5);
    assert.equal(texture.minFilter, NearestFilter);
    assert.equal(texture.magFilter, NearestFilter);
    assert.equal(texture.generateMipmaps, false);
    assert.ok(new Raycaster(new Vector3(0, -1, 0), new Vector3(0, 1, 0)).intersectObject(base).length > 0);
  } finally { solid.dispose(); texture.dispose(); }
});
