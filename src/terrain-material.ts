import { DoubleSide, MeshLambertMaterial } from 'three';
import type { Texture } from 'three';
import { TERRAIN_SHADOW_FRAGMENT } from './shadows.ts';
import type { TerrainPaint } from './shadows.ts';

/** Share the national mask with Three's depth pass as well as visible relief. */
export function createTerrainMaterial(mask: Texture, paint: TerrainPaint): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ color: '#ffffff', alphaMap: mask, alphaTest: 0.5 });
  material.shadowSide = DoubleSide;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, paint);
    shader.vertexShader = 'varying vec2 vCountryUv;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>',
      '#include <uv_vertex>\nvCountryUv = uv;');
    shader.fragmentShader = `uniform vec3 litColor;
      uniform vec3 shadowColor;
      uniform float flatReference;
      uniform float lightPresence;
      varying vec2 vCountryUv;
      float pigment(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
        vec4 n = fract(sin(vec4(dot(i,vec2(127.1,311.7)),
          dot(i+vec2(1.,0.),vec2(127.1,311.7)),
          dot(i+vec2(0.,1.),vec2(127.1,311.7)),
          dot(i+vec2(1.,1.),vec2(127.1,311.7))))*43758.5453);
        return mix(mix(n.x,n.y,f.x),mix(n.z,n.w,f.x),f.y);
      }\n` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', TERRAIN_SHADOW_FRAGMENT);
    // Defer visible alpha discard until derivatives have been evaluated. The
    // separate, unmodified shadow depth pass uses the standard alpha test.
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', '');
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      vec2 grainCoord = vCountryUv * vec2(370.,240.);
      vec2 grainWidth = fwidth(grainCoord);
      if (diffuseColor.a < 0.5) discard;
      diffuseColor.a = 1.0;
      float visibility = flatReference > 0.000001
        ? clamp(reflectedLight.directDiffuse.r * PI / flatReference, 0.0, 1.0) : 0.0;
      float shade = 1.0 - visibility * lightPresence;
      float grainAmount = 1.0 - smoothstep(0.35, 0.8, max(grainWidth.x, grainWidth.y));
      shade = clamp(shade * (1.0 + 0.06 * (pigment(grainCoord) - 0.5) * grainAmount), 0.0, 1.0);
      outgoingLight = mix(litColor, shadowColor, shade);
      #include <opaque_fragment>
    `);
  };
  return material;
}
