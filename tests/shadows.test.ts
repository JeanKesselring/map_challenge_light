import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Mesh, MeshBasicMaterial,
  OrthographicCamera, Raycaster, Texture, Vector3 } from 'three';
import { lightDirection, SkyModel } from '../src/astronomy.ts';
import { createShadowReceiver, fitDirectionalShadow, layoutShadowReceiver, stableShadowFrustum } from '../src/shadows.ts';
import { terrainVertices } from '../src/terrain.ts';
import { createTerrainMaterial } from '../src/terrain-material.ts';

const paint = {
  litColor: { value: new Color('#f6eae2') }, shadowColor: { value: new Color('#5d697d') },
  flatReference: { value: 1 }, lightPresence: { value: 1 },
};

test('shadow frusta contain the entire country at grazing and daytime light angles', () => {
  const country = new Box3(new Vector3(-192, 0, -120), new Vector3(192, 4.7, 120));
  const reported = new SkyModel().at(Date.parse('2026-11-03T10:00:00Z')).sun;
  const positions = [reported, ...[0.25, 1, 3, 10, 45, 85].map(altitude => ({ altitude, azimuth: 135 }))];
  for (const { altitude, azimuth } of positions) for (const resolution of [1024, 2048]) {
    const camera = new OrthographicCamera();
    const centre = country.getCenter(new Vector3());
    camera.position.fromArray(lightDirection(azimuth, altitude)).multiplyScalar(600).add(centre);
    camera.lookAt(centre); camera.updateMatrixWorld();
    const corners: Vector3[] = [];
    for (const x of [country.min.x, country.max.x]) for (const y of [country.min.y, country.max.y]) {
      for (const z of [country.min.z, country.max.z]) corners.push(new Vector3(x, y, z));
    }
    const lightSpace = new Box3().setFromPoints(corners.map(point => point.clone().applyMatrix4(camera.matrixWorldInverse)));
    Object.assign(camera, stableShadowFrustum(lightSpace, { x: resolution, y: resolution }));
    camera.updateProjectionMatrix();
    for (const point of corners) {
      const clip = point.clone().project(camera);
      assert.ok(Math.abs(clip.x) <= 1 && Math.abs(clip.y) <= 1 && Math.abs(clip.z) <= 1);
    }
  }
});

test('a ridge casts onto a real backdrop beyond both the country and elevation grid', () => {
  const metadata = {
    schemaVersion: 1, width: 9, height: 3, spacingMeters: 500, west: 0, north: 1000,
    crs: 'EPSG:21781', rowOrder: 'north-to-south', heightEncoding: 'uint16-le-metres-LN02',
    countryBounds: [0, 0, 2000, 1000] as [number, number, number, number],
  };
  const heights = new Uint16Array(27);
  for (let row = 0; row < 3; row++) heights[row * 9 + 3] = 1000;
  const grid = terrainVertices(metadata, heights);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(grid.positions, 3));
  geometry.setIndex(new BufferAttribute(grid.indices, 1));
  const material = new MeshBasicMaterial({ side: DoubleSide });
  const terrain = new Mesh(geometry, material);
  terrain.updateMatrixWorld();
  const backdrop = createShadowReceiver(paint);
  const view = new OrthographicCamera(-10, 10, 5, -5);
  view.position.set(0, 500, 0);
  layoutShadowReceiver(backdrop, view);
  const sun = new Vector3().fromArray(lightDirection(270, 15));
  try {
    // Country ends at x = 0, elevation grid at x = 2 km. The backdrop
    // at x = 3 km receives the 1 km ridge's shadow even without terrain there.
    const abroad = new Vector3(3, 0.001, 0);
    const down = new Raycaster(new Vector3(3, 10, 0), new Vector3(0, -1, 0));
    assert.equal(down.intersectObject(terrain).length, 0, 'there is no DEM surface at the receiver');
    assert.ok(down.intersectObject(backdrop).length > 0, 'the backdrop fills the missing surface');
    assert.ok(new Raycaster(abroad, sun).intersectObject(terrain).length > 0);
    assert.equal(new Raycaster(new Vector3(5, 0.001, 0), sun).intersectObject(terrain).length, 0);
    assert.equal(new Raycaster(abroad, new Vector3().fromArray(lightDirection(90, 30)))
      .intersectObject(terrain).length, 0);
    assert.equal(backdrop.receiveShadow, true);
    assert.equal(backdrop.castShadow, false);
  } finally { geometry.dispose(); material.dispose(); backdrop.geometry.dispose(); backdrop.material.dispose(); }
});

test('shadow cameras include long projected shadows on the backdrop at grazing angles', () => {
  const casters = new Box3(new Vector3(-2, 0, -1), new Vector3(2, 1, 1));
  const receivers = new Box3(new Vector3(-150, 0, -150), new Vector3(150, 0, 150));
  const peak = new Vector3(-0.5, 1, 0);
  for (const altitude of [0.5, 1, 5, 45, 85]) for (const azimuth of [0, 90, 180, 270]) {
    const light = new DirectionalLight();
    const direction = lightDirection(azimuth, altitude);
    fitDirectionalShadow(light, casters, receivers, direction);
    const destination = peak.clone().addScaledVector(new Vector3().fromArray(direction), -peak.y / direction[1]);
    const casterCoord = peak.clone().applyMatrix4(light.shadow.matrix);
    const receiverCoord = destination.clone().applyMatrix4(light.shadow.matrix);
    assert.ok(receiverCoord.toArray().every(value => value >= 0 && value <= 1), 'receiver remains in the shadow map');
    assert.ok(Math.abs(casterCoord.x - receiverCoord.x) < 1e-10);
    assert.ok(Math.abs(casterCoord.y - receiverCoord.y) < 1e-10);
    assert.ok(receiverCoord.z > casterCoord.z, 'the mountain lies between the light and backdrop');
  }
});

test('the backdrop covers desktop and mobile views after resizing', () => {
  const backdrop = createShadowReceiver(paint);
  const view = new OrthographicCamera();
  view.position.set(13, 500, -8);
  try {
    for (const [width, height] of [[600, 240], [360, 600], [900, 180]]) {
      view.left = -width / 2; view.right = width / 2;
      view.top = height / 2; view.bottom = -height / 2;
      const bounds = layoutShadowReceiver(backdrop, view);
      assert.ok(Math.abs(bounds.min.x - (view.position.x + view.left)) < 1e-8);
      assert.ok(Math.abs(bounds.max.z - (view.position.z - view.bottom)) < 1e-8);
      for (const x of [view.left * 0.99, view.right * 0.99]) for (const z of [view.bottom * 0.99, view.top * 0.99]) {
        assert.ok(new Raycaster(new Vector3(view.position.x + x, 10, view.position.z + z), new Vector3(0, -1, 0))
          .intersectObject(backdrop).length > 0);
      }
    }
  } finally { backdrop.geometry.dispose(); backdrop.material.dispose(); }
});

test('the country mask also clips the standard Three.js shadow depth pass', () => {
  const mask = new Texture();
  const material = createTerrainMaterial(mask, paint);
  try {
    // WebGLShadowMap copies these properties onto its depth material. A
    // country discard in the visible shader alone leaves foreign casters.
    assert.equal(material.alphaMap, mask);
    assert.equal(material.alphaTest, 0.5);
    assert.equal(material.shadowSide, DoubleSide);
    assert.equal(material.transparent, false);
  } finally { material.dispose(); mask.dispose(); }
});
test('subtexel light-space drift does not shift the shadow projection', () => {
  const bounds = new Box3(new Vector3(-190,-60,-800), new Vector3(190,60,-400));
  const map = { x: 2048, y: 2048 };
  const first = stableShadowFrustum(bounds,map);
  const movement = new Vector3((first.right-first.left)/map.x*0.2, (first.top-first.bottom)/map.y*0.2, 0);
  const next = stableShadowFrustum(bounds.clone().translate(movement),map);
  assert.deepEqual(next,first);
});
