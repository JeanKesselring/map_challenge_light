import {
  Box3, BufferAttribute, BufferGeometry, Color,
  DirectionalLight, Mesh, NoToneMapping, OrthographicCamera,
  PCFShadowMap, Scene, SRGBColorSpace, TextureLoader, WebGLRenderer,
} from 'three';
import type { MeshLambertMaterial } from 'three';
import { lightDirection } from './astronomy.ts';
import type { LightState } from './astronomy.ts';
import { FALLBACK_PALETTE, paletteFor } from './palette.ts';
import { decodeElevations, terrainVertices, validateMetadata } from './terrain.ts';
import type { TerrainMetadata } from './terrain.ts';
import { createShadowReceiver, fitDirectionalShadow, layoutShadowReceiver } from './shadows.ts';
import { createTerrainMaterial } from './terrain-material.ts';
import { readMaskRaster, TerrainSolid } from './terrain-solid.ts';

const DATA_URL = `${import.meta.env.BASE_URL}terrain/`;

export class TerrainRenderer {
  private readonly gpu: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-200, 200, 150, -150, 1, 1200);
  private readonly sun = new DirectionalLight('#ffffff', 2.6);
  private readonly moon = new DirectionalLight('#ffffff', 0);
  private readonly paint = {
    litColor: { value: new Color(FALLBACK_PALETTE.background) },
    shadowColor: { value: new Color(FALLBACK_PALETTE.shadow) },
    flatReference: { value: 1 },
    lightPresence: { value: 1 },
  };
  private readonly resizeObserver: ResizeObserver;
  private metadata: TerrainMetadata;
  private geometry: BufferGeometry;
  private material: MeshLambertMaterial;
  private readonly bounds: Box3;
  private readonly backdrop: ReturnType<typeof createShadowReceiver>;
  private readonly solid: TerrainSolid;
  private receiverBounds = new Box3();
  private shadowFitDirty = true;
  private disposed = false;
  private scale = 1;
  private frameDuration = 0;
  private slowFrames = 0;
  private readonly container: HTMLElement;

  private constructor(container: HTMLElement, metadata: TerrainMetadata,
    heights: Uint16Array, mask: Awaited<ReturnType<TextureLoader['loadAsync']>>) {
    this.container = container;
    this.metadata = metadata;
    this.gpu = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.gpu.outputColorSpace = SRGBColorSpace;
    this.gpu.toneMapping = NoToneMapping;
    this.gpu.setClearColor(FALLBACK_PALETTE.background, 0);
    this.gpu.shadowMap.enabled = true;
    this.gpu.shadowMap.type = PCFShadowMap;
    this.gpu.shadowMap.autoUpdate = false;
    this.gpu.debug.onShaderError = () => { throw new Error('Live lighting shader could not be initialized.'); };
    this.gpu.domElement.setAttribute('aria-hidden', 'true');

    performance.mark('terrain-geometry-start');
    const grid = terrainVertices(metadata, heights);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(grid.positions, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(grid.normals, 3));
    this.geometry.setAttribute('uv', new BufferAttribute(grid.uv, 2));
    this.geometry.setIndex(new BufferAttribute(grid.indices, 1));
    this.geometry.computeBoundingBox();
    this.bounds = this.geometry.boundingBox!.clone();

    this.material = createTerrainMaterial(mask, this.paint);
    this.solid = new TerrainSolid(metadata, heights, mask, readMaskRaster(mask));
    performance.measure('terrain-geometry', 'terrain-geometry-start');
    this.backdrop = createShadowReceiver(this.paint);
    const terrain = new Mesh(this.geometry, this.material);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    this.scene.add(this.backdrop, terrain, this.solid, this.sun, this.sun.target, this.moon, this.moon.target);
    for (const light of [this.sun, this.moon]) {
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.normalBias = 0.005;
      light.shadow.bias = -0.000015;
      light.shadow.autoUpdate = false;
    }
    this.camera.up.set(0, 0, -1);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    container.append(this.gpu.domElement);
    this.resize();
    this.gpu.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      container.dispatchEvent(new CustomEvent('render-failure'));
    });
    const disposeMask = this.material.dispose.bind(this.material);
    this.material.dispose = () => { mask.dispose(); disposeMask(); };
  }

  static async load(container: HTMLElement, onPreparing: () => void = () => {}): Promise<TerrainRenderer> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      performance.mark('terrain-download-start');
      const [metadataResponse, heightResponse, maskResponse] = await Promise.all([
        fetch(`${DATA_URL}metadata.json`, { signal: controller.signal }),
        fetch(`${DATA_URL}elevation.bin`, { signal: controller.signal }),
        fetch(`${DATA_URL}mask.png`, { signal: controller.signal }),
      ]);
      if (!metadataResponse.ok || !heightResponse.ok || !maskResponse.ok) throw new Error('Terrain could not be loaded.');
      const metadata = validateMetadata(await metadataResponse.json());
      const [heightBuffer, maskBlob] = await Promise.all([heightResponse.arrayBuffer(), maskResponse.blob()]);
      performance.measure('terrain-download', 'terrain-download-start');
      const heights = decodeElevations(heightBuffer, metadata);
      const maskUrl = URL.createObjectURL(maskBlob);
      try {
        const mask = await new TextureLoader().loadAsync(maskUrl);
        onPreparing();
        try { return new TerrainRenderer(container, metadata, heights, mask); }
        catch (error) { mask.dispose(); throw error; }
      } finally { URL.revokeObjectURL(maskUrl); }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Let parallel shader compilation finish before submitting the first frame. */
  async prepare(): Promise<void> {
    performance.mark('terrain-shaders-start');
    await this.gpu.compileAsync(this.scene, this.camera);
    performance.measure('terrain-shaders', 'terrain-shaders-start');
    if (this.disposed || this.gpu.getContext().isContextLost()) throw new Error('Live rendering is unavailable.');
  }

  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    this.gpu.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * this.scale);
    this.gpu.setSize(width, height);
    const m = this.metadata, [west, south, east, north] = m.countryBounds;
    const cx = ((west + east) / 2 - m.west - (m.width - 1) * m.spacingMeters / 2) / 1000;
    const cz = (m.north - (north + south) / 2 - (m.height - 1) * m.spacingMeters / 2) / 1000;
    const aspect = width / height;
    const halfHeight = Math.max((north - south) / 2000, (east - west) / 2000 / aspect) * 1.08;
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.position.set(cx, 500, cz);
    this.camera.lookAt(cx, 0, cz);
    this.camera.updateProjectionMatrix();
    this.receiverBounds.copy(layoutShadowReceiver(this.backdrop, this.camera));
    this.shadowFitDirty = true;
  }

  private positionLight(light: DirectionalLight, azimuth: number, altitude: number): void {
    fitDirectionalShadow(light, this.bounds, this.receiverBounds, lightDirection(azimuth, altitude));
  }

  update(state: LightState, shadows = true): void {
    const palette = paletteFor(state);
    this.paint.litColor.value.set(palette.background);
    this.paint.shadowColor.value.set(palette.shadow);
    this.paint.flatReference.value = state.sunStrength * Math.max(0, Math.sin(state.sun.altitude * Math.PI / 180))
      + state.moonStrength * Math.max(0, Math.sin(state.moon.altitude * Math.PI / 180));
    const presence = Math.min(1, (state.sunStrength + state.moonStrength) / 0.12);
    this.paint.lightPresence.value = presence * presence * (3 - 2 * presence);
    this.sun.intensity = state.sunStrength;
    this.moon.intensity = state.moonStrength;
    // Avoid filtering an inactive light's map; the tent kernel spends its taps
    // on the illuminating body, including during accelerated playback.
    this.sun.shadow.intensity = state.sunStrength > 0 ? 1 : 0;
    this.moon.shadow.intensity = state.moonStrength > 0 ? 1 : 0;
    if (shadows || this.shadowFitDirty) {
      if (state.sunStrength > 0) this.positionLight(this.sun, state.sun.azimuth, state.sun.altitude);
      if (state.moonStrength > 0) this.positionLight(this.moon, state.moon.azimuth, state.moon.altitude);
      // Initialising both shadow textures once avoids sampling an unallocated shadow map.
      for (const light of [this.sun, this.moon]) {
        if (!light.shadow.map && light.intensity === 0) this.positionLight(light, 180, 45);
      }
      this.gpu.shadowMap.needsUpdate = true;
      this.shadowFitDirty = false;
    }
  }

  draw(): void {
    if (!this.disposed) this.gpu.render(this.scene, this.camera);
  }

  /** Reduce pixel fill and shadow resolution before touching geographical detail. */
  measure(duration: number): void {
    this.frameDuration = this.frameDuration * 0.9 + duration * 0.1;
    if (this.frameDuration > 30) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 60 && this.scale > 0.65) {
      this.scale = 0.65;
      this.slowFrames = 0;
      for (const light of [this.sun, this.moon]) {
        light.shadow.map?.dispose();
        light.shadow.map = null;
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.needsUpdate = true;
      }
      this.gpu.shadowMap.needsUpdate = true;
      this.resize();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.geometry.dispose();
    this.material.dispose();
    this.backdrop.geometry.dispose();
    this.backdrop.material.dispose();
    this.solid.dispose();
    this.sun.shadow.dispose();
    this.moon.shadow.dispose();
    this.gpu.dispose();
    this.gpu.domElement.remove();
  }
}
