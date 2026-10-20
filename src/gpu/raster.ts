/** VRAM is 1024 × 512 16-bit pixels (5-5-5 BGR with a mask bit on top). */
export const VRAM_WIDTH = 1024;
export const VRAM_HEIGHT = 512;

/** The 4×4 dither offsets added to 8-bit colour before it is cut to 5 bits. */
const DITHER = [
  [-4, 0, -3, 1],
  [2, -2, 3, -1],
  [-3, 1, -4, 0],
  [3, -1, 2, -2],
];

export const DRAW_SHADED = 1;
export const DRAW_TEXTURED = 2;
export const DRAW_RAW = 4;
export const DRAW_SEMI = 8;

/** One vertex: position, colour and texture coordinate. */
export interface Vertex {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  u: number;
  v: number;
}

export const vertex = (): Vertex => ({ x: 0, y: 0, r: 0, g: 0, b: 0, u: 0, v: 0 });

/**
 * Draws into VRAM as the GPU does. The GPU sets the drawing state (draw area,
 * texture page, colour table, window, blending, mask) before each primitive.
 */
export class Rasterizer {
  // Draw area, inclusive.
  left = 0;
  top = 0;
  right = 0;
  bottom = 0;
  dither = false;
  /** 0x8000 when drawn pixels get the mask bit set. */
  maskOr = 0;
  /** Pixels whose mask bit is set are left alone. */
  checkMask = false;
  semiMode = 0;
  // Texture page (in VRAM pixels), depth (0 = 4-bit, 1 = 8-bit, 2 = 15-bit) and colour table.
  pageX = 0;
  pageY = 0;
  depth = 0;
  clutX = 0;
  clutY = 0;
  // Texture window, already in pixels: u = (u & ~maskX) | offsetX.
  windowMaskX = 0;
  windowMaskY = 0;
  windowOffsetX = 0;
  windowOffsetY = 0;

  constructor(readonly vram: Uint16Array) {}

  /** The colour-table index or direct colour at texture coordinate (u, v); 0 is transparent. */
  private texel(u: number, v: number): number {
    u = ((u & ~this.windowMaskX) | this.windowOffsetX) & 0xff;
    v = ((v & ~this.windowMaskY) | this.windowOffsetY) & 0xff;
    const vram = this.vram;
    const row = ((this.pageY + v) & 511) * VRAM_WIDTH;
    switch (this.depth) {
      case 0: {
        const word = vram[row + ((this.pageX + (u >> 2)) & 1023)];
        const index = (word >> ((u & 3) * 4)) & 0xf;
        return vram[this.clutY * VRAM_WIDTH + ((this.clutX + index) & 1023)];
      }
      case 1: {
        const word = vram[row + ((this.pageX + (u >> 1)) & 1023)];
        const index = (word >> ((u & 1) * 8)) & 0xff;
        return vram[this.clutY * VRAM_WIDTH + ((this.clutX + index) & 1023)];
      }
      default:
        return vram[row + ((this.pageX + u) & 1023)];
    }
  }

  /** Writes one pixel from 8-bit colour (or a texel), with blending, dithering and the mask bit. */
  private plot(x: number, y: number, r: number, g: number, b: number, u: number, v: number, flags: number, dither: boolean): void {
    const index = y * VRAM_WIDTH + x;
    const vram = this.vram;
    const destination = vram[index];
    if (this.checkMask && destination & 0x8000) return;
    let semi = (flags & DRAW_SEMI) !== 0;
    let maskBit = this.maskOr;
    if (flags & DRAW_TEXTURED) {
      const texel = this.texel(u, v);
      if (texel === 0) return;
      if (!(texel & 0x8000)) semi = false;
      maskBit |= texel & 0x8000;
      if (flags & DRAW_RAW) {
        r = (texel & 0x1f) << 3;
        g = ((texel >> 5) & 0x1f) << 3;
        b = ((texel >> 10) & 0x1f) << 3;
      } else {
        r = ((texel & 0x1f) * r) >> 4;
        g = (((texel >> 5) & 0x1f) * g) >> 4;
        b = (((texel >> 10) & 0x1f) * b) >> 4;
      }
    }
    if (dither) {
      const offset = DITHER[y & 3][x & 3];
      r += offset;
      g += offset;
      b += offset;
    }
    r = r < 0 ? 0 : r > 255 ? 31 : r >> 3;
    g = g < 0 ? 0 : g > 255 ? 31 : g >> 3;
    b = b < 0 ? 0 : b > 255 ? 31 : b >> 3;
    if (semi) {
      const br = destination & 0x1f;
      const bg = (destination >> 5) & 0x1f;
      const bb = (destination >> 10) & 0x1f;
      switch (this.semiMode) {
        case 0:
          r = (br + r) >> 1;
          g = (bg + g) >> 1;
          b = (bb + b) >> 1;
          break;
        case 1:
          r = Math.min(31, br + r);
          g = Math.min(31, bg + g);
          b = Math.min(31, bb + b);
          break;
        case 2:
          r = Math.max(0, br - r);
          g = Math.max(0, bg - g);
          b = Math.max(0, bb - b);
          break;
        default:
          r = Math.min(31, br + (r >> 2));
          g = Math.min(31, bg + (g >> 2));
          b = Math.min(31, bb + (b >> 2));
      }
    }
    vram[index] = r | (g << 5) | (b << 10) | maskBit;
  }

  /** A triangle, with the right and bottom edges left out (so shared edges are drawn once). */
  triangle(a: Vertex, b: Vertex, c: Vertex, flags: number): void {
    let area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (area === 0) return;
    if (area < 0) {
      const swap = b;
      b = c;
      c = swap;
      area = -area;
    }
    const minX = Math.max(Math.min(a.x, b.x, c.x), this.left);
    const maxX = Math.min(Math.max(a.x, b.x, c.x), this.right);
    const minY = Math.max(Math.min(a.y, b.y, c.y), this.top);
    const maxY = Math.min(Math.max(a.y, b.y, c.y), this.bottom);
    if (minX > maxX || minY > maxY) return;

    // Edge functions E = A·x + B·y + C, inside where E >= threshold (0 on top and left edges, 1 elsewhere).
    const edges = [a, b, b, c, c, a];
    const ea = [0, 0, 0];
    const eb = [0, 0, 0];
    const ec = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const p = edges[i * 2];
      const q = edges[i * 2 + 1];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      ea[i] = -dy;
      eb[i] = dx;
      const topLeft = dy < 0 || (dy === 0 && dx > 0);
      ec[i] = dy * p.x - dx * p.y - (topLeft ? 0 : 1);
    }

    const shaded = (flags & DRAW_SHADED) !== 0;
    const textured = (flags & DRAW_TEXTURED) !== 0;
    const dither = this.dither && (shaded || (textured && !(flags & DRAW_RAW)));
    const x1 = b.x - a.x;
    const y1 = b.y - a.y;
    const x2 = c.x - a.x;
    const y2 = c.y - a.y;
    const gradX = (va: number, vb: number, vc: number) => ((vb - va) * y2 - (vc - va) * y1) / area;
    const gradY = (va: number, vb: number, vc: number) => ((vc - va) * x1 - (vb - va) * x2) / area;
    const drdx = shaded ? gradX(a.r, b.r, c.r) : 0;
    const drdy = shaded ? gradY(a.r, b.r, c.r) : 0;
    const dgdx = shaded ? gradX(a.g, b.g, c.g) : 0;
    const dgdy = shaded ? gradY(a.g, b.g, c.g) : 0;
    const dbdx = shaded ? gradX(a.b, b.b, c.b) : 0;
    const dbdy = shaded ? gradY(a.b, b.b, c.b) : 0;
    const dudx = textured ? gradX(a.u, b.u, c.u) : 0;
    const dudy = textured ? gradY(a.u, b.u, c.u) : 0;
    const dvdx = textured ? gradX(a.v, b.v, c.v) : 0;
    const dvdy = textured ? gradY(a.v, b.v, c.v) : 0;
    const minU = Math.min(a.u, b.u, c.u);
    const maxU = Math.max(a.u, b.u, c.u);
    const minV = Math.min(a.v, b.v, c.v);
    const maxV = Math.max(a.v, b.v, c.v);
    const EPSILON = 1 / 1024;

    for (let y = minY; y <= maxY; y++) {
      let left = minX;
      let right = maxX;
      let empty = false;
      for (let i = 0; i < 3; i++) {
        const k = -eb[i] * y - ec[i];
        const ai = ea[i];
        if (ai > 0) left = Math.max(left, Math.ceil(k / ai));
        else if (ai < 0) right = Math.min(right, Math.floor(k / ai));
        else if (k > 0) empty = true;
      }
      if (empty || left > right) continue;
      const fx = left - a.x;
      const fy = y - a.y;
      let r = a.r + fx * drdx + fy * drdy;
      let g = a.g + fx * dgdx + fy * dgdy;
      let bl = a.b + fx * dbdx + fy * dbdy;
      let u = a.u + fx * dudx + fy * dudy + EPSILON;
      let v = a.v + fx * dvdx + fy * dvdy + EPSILON;
      for (let x = left; x <= right; x++) {
        let tu = 0;
        let tv = 0;
        if (textured) {
          tu = Math.floor(u);
          tv = Math.floor(v);
          tu = tu < minU ? minU : tu > maxU ? maxU : tu;
          tv = tv < minV ? minV : tv > maxV ? maxV : tv;
        }
        if (shaded) this.plot(x, y, Math.floor(r + 0.5), Math.floor(g + 0.5), Math.floor(bl + 0.5), tu, tv, flags, dither);
        else this.plot(x, y, a.r, a.g, a.b, tu, tv, flags, dither);
        r += drdx;
        g += dgdx;
        bl += dbdx;
        u += dudx;
        v += dvdx;
      }
    }
  }

  /** A rectangle (sprite), never dithered; textures can be flipped. */
  rectangle(x: number, y: number, width: number, height: number, color: Vertex, flags: number, flipX: boolean, flipY: boolean): void {
    const x0 = Math.max(x, this.left);
    const y0 = Math.max(y, this.top);
    const x1 = Math.min(x + width - 1, this.right);
    const y1 = Math.min(y + height - 1, this.bottom);
    const du = flipX ? -1 : 1;
    const dv = flipY ? -1 : 1;
    // Flipped horizontally, the hardware starts from an odd U.
    const u0 = flipX ? color.u | 1 : color.u;
    for (let py = y0; py <= y1; py++) {
      const v = (color.v + (py - y) * dv) & 0xff;
      for (let px = x0; px <= x1; px++) {
        const u = (u0 + (px - x) * du) & 0xff;
        this.plot(px, py, color.r, color.g, color.b, u, v, flags, false);
      }
    }
  }

  /** A line, both ends included, colour interpolated along it when shaded. */
  line(a: Vertex, b: Vertex, flags: number): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    const shaded = (flags & DRAW_SHADED) !== 0;
    const dither = this.dither && shaded;
    const stepX = steps ? dx / steps : 0;
    const stepY = steps ? dy / steps : 0;
    const stepR = shaded && steps ? (b.r - a.r) / steps : 0;
    const stepG = shaded && steps ? (b.g - a.g) / steps : 0;
    const stepB = shaded && steps ? (b.b - a.b) / steps : 0;
    let x = a.x + 0.5;
    let y = a.y + 0.5;
    let r = a.r + 0.5;
    let g = a.g + 0.5;
    let bl = a.b + 0.5;
    for (let i = 0; i <= steps; i++) {
      const px = Math.floor(x);
      const py = Math.floor(y);
      if (px >= this.left && px <= this.right && py >= this.top && py <= this.bottom) {
        this.plot(px, py, Math.floor(r), Math.floor(g), Math.floor(bl), 0, 0, flags & ~DRAW_TEXTURED, dither);
      }
      x += stepX;
      y += stepY;
      r += stepR;
      g += stepG;
      bl += stepB;
    }
  }
}
