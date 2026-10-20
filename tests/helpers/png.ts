import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from '../../src/util/crc32';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes RGB pixels (3 bytes each) as a PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** VRAM (1024×512, 15-bit) as a PNG. */
export function vramPng(vram: Uint16Array): Uint8Array {
  const rgb = new Uint8Array(1024 * 512 * 3);
  for (let i = 0; i < vram.length; i++) {
    const p = vram[i];
    rgb[i * 3] = (p & 0x1f) << 3;
    rgb[i * 3 + 1] = ((p >> 5) & 0x1f) << 3;
    rgb[i * 3 + 2] = ((p >> 10) & 0x1f) << 3;
  }
  return encodePng(1024, 512, rgb);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decodes a non-interlaced PNG of any colour type and bit depth into 8-bit RGB. */
export function decodePng(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 0;
  let palette = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      palette = data.slice();
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);
  const bitsPerPixel = channels * depth;
  const filterBytes = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of idat) {
    joined.set(part, at);
    at += part.length;
  }
  const raw = inflateSync(joined);
  const bytes = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = bytes.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? bytes.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= filterBytes ? out[x - filterBytes] : 0;
      const up = previous[x];
      const upLeft = x >= filterBytes ? previous[x - filterBytes] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[x] = value & 0xff;
    }
  }
  /** Sample `c` of pixel (x, y), scaled to 8 bits. */
  const sample = (x: number, y: number, c: number): number => {
    const bit = (x * channels + c) * depth;
    const row = y * stride;
    if (depth === 16) return bytes[row + (bit >> 3)];
    if (depth === 8) return bytes[row + (bit >> 3)];
    const value = (bytes[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return colorType === 3 ? value : Math.round((value * 255) / ((1 << depth) - 1));
  };
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (colorType === 3) rgb.set(palette.subarray(sample(x, y, 0) * 3, sample(x, y, 0) * 3 + 3), o);
      else if (colorType === 0 || colorType === 4) rgb.fill(sample(x, y, 0), o, o + 3);
      else for (let c = 0; c < 3; c++) rgb[o + c] = sample(x, y, c);
    }
  }
  return { width, height, rgb };
}
