import { BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial,
  NearestFilter, PlaneGeometry } from 'three';
import type { Texture } from 'three';
import type { Heights, TerrainMetadata } from './terrain.ts';

export interface MaskRaster {
  width: number;
  height: number;
  /** North-first grayscale or RGBA pixels. */
  data: Uint8Array | Uint8ClampedArray;
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > 4096 || height > 4096) throw new Error('Invalid country mask dimensions.');
}

/** Read the already-loaded local mask once; no extra terrain asset is required. */
export function readMaskRaster(texture: Texture): MaskRaster {
  const image = texture.image as HTMLImageElement;
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  validateDimensions(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot read the country mask.');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height);
  } finally { canvas.width = 1; canvas.height = 1; }
}

function boundaryWalls(metadata: TerrainMetadata, heights: Heights, mask: MaskRaster): BufferGeometry {
  validateDimensions(mask.width, mask.height);
  const channels = mask.data.length / (mask.width * mask.height);
  if ((channels !== 1 && channels !== 4) || heights.length !== metadata.width * metadata.height) {
    throw new Error('Terrain extrusion dimensions do not match.');
  }
  const { width, height } = metadata, step = metadata.spacingMeters / 1000;
  const halfX = (width - 1) * step / 2, halfZ = (height - 1) * step / 2;
  const positions: number[] = [], indices: number[] = [];
  const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < mask.width && z < mask.height
    && mask.data[(z * mask.width + x) * channels] >= 128;
  const elevation = (x: number, z: number) => {
    const col = Math.min(width - 2, Math.max(0, Math.floor(x)));
    const row = Math.min(height - 2, Math.max(0, Math.floor(z)));
    const dx = x - col, dz = z - row, i = row * width + col;
    // Match terrainVertices' two triangles, rather than bilinear smoothing.
    return (dx + dz <= 1
      ? heights[i] + (heights[i + 1] - heights[i]) * dx + (heights[i + width] - heights[i]) * dz
      : heights[i + width + 1] + (heights[i + width] - heights[i + width + 1]) * (1 - dx)
        + (heights[i + 1] - heights[i + width + 1]) * (1 - dz)) / 1000;
  };
  const edge = (x0: number, z0: number, x1: number, z1: number) => {
    const ax = x0 / mask.width * (width - 1), az = z0 / mask.height * (height - 1);
    const bx = x1 / mask.width * (width - 1), bz = z1 / mask.height * (height - 1);
    const cuts = [0, 1];
    // Split at cell boundaries and NW/SE triangle boundaries. Every top edge
    // then lies on one roof triangle, closing seams even on steep slopes.
    for (const [a, b] of [[ax, bx], [az, bz], [ax + az, bx + bz]]) {
      for (let k = Math.floor(Math.min(a, b)) + 1; k < Math.max(a, b) - 1e-10; k++) {
        const t = (k - a) / (b - a);
        if (t > 1e-10 && t < 1 - 1e-10) cuts.push(t);
      }
    }
    cuts.sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      if (cuts[i] - cuts[i - 1] < 1e-10) continue;
      if (positions.length >= 200_000 * 12) throw new Error('Country boundary exceeds geometry budget.');
      const start = cuts[i - 1], end = cuts[i];
      const x = ax + (bx - ax) * start, z = az + (bz - az) * start;
      const X = ax + (bx - ax) * end, Z = az + (bz - az) * end;
      const index = positions.length / 3;
      positions.push(x * step - halfX, elevation(x, z), z * step - halfZ,
        x * step - halfX, 0, z * step - halfZ,
        X * step - halfX, elevation(X, Z), Z * step - halfZ,
        X * step - halfX, 0, Z * step - halfZ);
      indices.push(index, index + 2, index + 1, index + 2, index + 3, index + 1);
    }
  };
  for (let row = 0; row < mask.height; row++) for (let col = 0; col < mask.width; col++) {
    if (!inside(col, row)) continue;
    if (!inside(col, row - 1)) edge(col, row, col + 1, row);
    if (!inside(col + 1, row)) edge(col + 1, row, col + 1, row + 1);
    if (!inside(col, row + 1)) edge(col + 1, row + 1, col, row + 1);
    if (!inside(col - 1, row)) edge(col, row + 1, col, row);
  }
  if (!positions.length) throw new Error('Country mask is empty.');
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  return geometry;
}

/** Close the masked height field down to the Y=0 backdrop for shadow casting. */
export class TerrainSolid extends Group {
  private readonly walls: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly base: Mesh<PlaneGeometry, MeshBasicMaterial>;

  constructor(metadata: TerrainMetadata, heights: Heights, texture: Texture, mask: MaskRaster) {
    super();
    // Pixel edges are shared by roof, walls and bottom. Filtering the alpha
    // texture would move the roof boundary away from the physical wall.
    texture.minFilter = texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const invisible = { colorWrite: false, depthWrite: false, side: DoubleSide, shadowSide: DoubleSide };
    this.walls = new Mesh(boundaryWalls(metadata, heights, mask), new MeshBasicMaterial(invisible));
    const baseGeometry = new PlaneGeometry((metadata.width - 1) * metadata.spacingMeters / 1000,
      (metadata.height - 1) * metadata.spacingMeters / 1000);
    baseGeometry.rotateX(-Math.PI / 2);
    this.base = new Mesh(baseGeometry, new MeshBasicMaterial({ ...invisible, alphaMap: texture, alphaTest: 0.5 }));
    this.walls.name = 'terrain-walls'; this.base.name = 'terrain-base';
    this.walls.castShadow = this.base.castShadow = true;
    this.add(this.walls, this.base);
  }

  dispose(): void {
    for (const mesh of [this.walls, this.base]) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
}
