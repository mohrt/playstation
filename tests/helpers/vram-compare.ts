import { readFileSync } from 'node:fs';
import { decodePng } from './png';

export interface VramComparison {
  /** Share of pixels drawn the same as on the console. */
  same: number;
  /** Share within one colour step (rounding differences). */
  close: number;
}

/**
 * Compares VRAM with a console's VRAM screenshot (5-bit colour, so only the
 * top 5 bits of each channel count). Areas the test never drew are left out:
 * the screenshots show those as light grey, while emulated VRAM starts black.
 */
export function compareVram(vram: Uint16Array, pngPath: string): VramComparison {
  const ref = decodePng(new Uint8Array(readFileSync(pngPath)));
  let same = 0;
  let close = 0;
  let counted = 0;
  for (let i = 0; i < 1024 * 512; i++) {
    const p = vram[i];
    const r = (p & 31) << 3;
    const g = ((p >> 5) & 31) << 3;
    const b = ((p >> 10) & 31) << 3;
    const rr = ref.rgb[i * 3] & 0xf8;
    const rg = ref.rgb[i * 3 + 1] & 0xf8;
    const rb = ref.rgb[i * 3 + 2] & 0xf8;
    if ((p & 0x7fff) === 0 && rr === 0xf8 && rg === 0xf8 && rb === 0xf8) continue;
    counted++;
    const d = Math.max(Math.abs(r - rr), Math.abs(g - rg), Math.abs(b - rb));
    if (d === 0) same++;
    else if (d <= 8) close++;
  }
  return { same: counted ? same / counted : 1, close: counted ? close / counted : 0 };
}
