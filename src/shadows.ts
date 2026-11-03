import { Box3, Mesh, MeshLambertMaterial, PlaneGeometry, ShaderChunk, Vector3 } from 'three';
import type { Color, DirectionalLight, OrthographicCamera } from 'three';

export interface TerrainPaint {
  litColor: { value: Color };
  shadowColor: { value: Color };
  flatReference: { value: number };
  lightPresence: { value: number };
}

/** A real, flat shadow receiver behind the country, including beyond the DEM. */
export function createShadowReceiver(paint: TerrainPaint): Mesh<PlaneGeometry, MeshLambertMaterial> {
  const geometry = new PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = new MeshLambertMaterial({ color: '#ffffff' });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, paint);
    shader.fragmentShader = `uniform vec3 litColor;
      uniform vec3 shadowColor;
      uniform float flatReference;
      uniform float lightPresence;\n` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', TERRAIN_SHADOW_FRAGMENT);
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float visibility = flatReference > 0.000001
        ? clamp(reflectedLight.directDiffuse.r * PI / flatReference, 0.0, 1.0) : 1.0;
      float shade = (1.0 - visibility) * lightPresence;
      outgoingLight = mix(litColor, shadowColor, shade);
      #include <opaque_fragment>
    `);
  };
  const receiver = new Mesh(geometry, material);
  receiver.name = 'shadow-backdrop';
  receiver.receiveShadow = true;
  receiver.castShadow = false;
  receiver.renderOrder = -1;
  return receiver;
}

/** Cover the fixed north-up camera's complete footprint after each resize. */
export function layoutShadowReceiver(receiver: Mesh<PlaneGeometry, MeshLambertMaterial>, camera: OrthographicCamera): Box3 {
  receiver.position.set(camera.position.x + (camera.left + camera.right) / 2, 0,
    camera.position.z - (camera.top + camera.bottom) / 2);
  receiver.scale.set(camera.right - camera.left, 1, camera.top - camera.bottom);
  receiver.updateMatrixWorld();
  return new Box3().setFromObject(receiver);
}

/** Fit both casters and receivers; caster-only depth clips long ground shadows. */
export function fitDirectionalShadow(light: DirectionalLight, casters: Box3, receivers: Box3,
  direction: readonly [number, number, number]): void {
  const bounds = casters.clone().union(receivers);
  const centre = bounds.getCenter(new Vector3());
  const distance = Math.max(600, bounds.getSize(new Vector3()).length() + 10);
  light.target.position.copy(centre);
  light.position.fromArray(direction).multiplyScalar(distance).add(centre);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();
  light.shadow.updateMatrices(light);
  const projected = bounds.clone().applyMatrix4(light.shadow.camera.matrixWorldInverse);
  Object.assign(light.shadow.camera, stableShadowFrustum(projected, light.shadow.mapSize));
  light.shadow.camera.updateProjectionMatrix();
  light.shadow.updateMatrices(light);
  light.shadow.needsUpdate = true;
}

/** Fit in light space and align the projection centre to shadow texels. */
export function stableShadowFrustum(bounds: Box3, mapSize: { x: number; y: number }): {
  left: number; right: number; bottom: number; top: number; near: number; far: number;
} {
  const width = bounds.max.x - bounds.min.x + 4;
  const height = bounds.max.y - bounds.min.y + 4;
  const texelX = width / mapSize.x, texelY = height / mapSize.y;
  const x = Math.round((bounds.min.x + bounds.max.x) / 2 / texelX) * texelX;
  const y = Math.round((bounds.min.y + bounds.max.y) / 2 / texelY) * texelY;
  return { left: x - width / 2, right: x + width / 2,
    bottom: y - height / 2, top: y + height / 2,
    near: Math.max(0.1, -bounds.max.z - 10), far: -bounds.min.z + 10 };
}

// A fixed tent filter avoids the engine's screen-space noise pattern. Each tap
// compares against the receiver plane at that tap, not the centre depth. The
// extra one-texel tolerance covers hardware bilinear comparisons on that plane.
const receiverPlanePCF = /* glsl */`
float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity,
  float shadowBias, float shadowRadius, vec4 shadowCoord ) {
  if (shadowIntensity <= 0.0) return 1.0;
  vec3 coord = shadowCoord.xyz / shadowCoord.w;
  vec3 dx = dFdx(coord);
  vec3 dy = dFdy(coord);
  float determinant = dx.x * dy.y - dx.y * dy.x;
  vec2 gradient = vec2(0.0);
  if (abs(determinant) > 0.000000000001) {
    gradient = vec2(dy.y * dx.z - dx.y * dy.z,
      dx.x * dy.z - dy.x * dx.z) / determinant;
  }
  vec2 texel = vec2(1.0) / shadowMapSize;
  float receiverError = dot(abs(gradient), texel);
  float referenceDepth = coord.z + shadowBias - receiverError;
  bool inside = coord.x >= 0.0 && coord.x <= 1.0
    && coord.y >= 0.0 && coord.y <= 1.0 && coord.z <= 1.0;
  if (!inside) return 1.0;
  float visibility = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y)) * texel * shadowRadius;
      float weight = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);
      float depth = referenceDepth + dot(gradient, offset);
      visibility += weight * texture(shadowMap, vec3(coord.xy + offset, depth));
    }
  }
  return mix(1.0, visibility / 16.0, shadowIntensity);
}
`;

const original = ShaderChunk.shadowmap_pars_fragment;
const start = original.indexOf('float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize');
const end = original.indexOf('#elif defined( SHADOWMAP_TYPE_VSM )', start);
if (start < 0 || end < 0) throw new Error('The terrain shadow filter must be updated for this Three.js version.');

export const TERRAIN_SHADOW_FRAGMENT = original.slice(0, start) + receiverPlanePCF + original.slice(end);

