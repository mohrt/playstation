/** Zigzag order: ZIGZAG[i] is where coefficient i of the stream goes in the 8×8 block. */
const ZIGZAG_ORDER = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20,
  22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
];
const ZAGZIG = new Uint8Array(64);
ZIGZAG_ORDER.forEach((zig, linear) => (ZAGZIG[zig] = linear));

const STATUS_OUT_EMPTY = 1 << 31;
const STATUS_BUSY = 1 << 29;
const STATUS_IN_REQUEST = 1 << 28;
const STATUS_OUT_REQUEST = 1 << 27;

const TWO_32 = 2 ** 32;
const TWO_31 = 2 ** 31;

const signed10 = (value: number) => (value << 22) >> 22;
const signed9 = (value: number) => (value << 23) >> 23;
const clampByte = (value: number) => (value < -128 ? -128 : value > 127 ? 127 : value);

/**
 * The MDEC decodes the run-length coded, quantised DCT blocks of video frames
 * and still images into pixels: 16×16 colour macroblocks (15- or 24-bit) or
 * 8×8 monochrome blocks (4- or 8-bit). Data goes in through DMA0 (or the
 * command register) and comes out through DMA1 (or the data register).
 */
export class Mdec {
  private readonly luminanceTable = new Uint8Array(64);
  private readonly colorTable = new Uint8Array(64);
  private readonly scaleTable = new Int16Array(64);

  /** Halfwords received for the current decode command. */
  private input = new Uint16Array(0x10000);
  private inputLength = 0;
  private inputPosition = 0;
  private command = 0;
  /** Parameter words the current command still expects. */
  private remaining = 0;
  private enableIn = false;
  private enableOut = false;

  private output = new Uint32Array(0x10000);
  private outputLength = 0;
  private outputPosition = 0;

  private readonly blocks = [new Int16Array(64), new Int16Array(64), new Int16Array(64), new Int16Array(64), new Int16Array(64), new Int16Array(64)];
  private readonly temp = new Float64Array(64);
  private readonly rgb = new Uint32Array(256);
  /** Called when decoded words become available (so a waiting DMA1 can run). */
  onOutput: () => void = () => {};

  reset(): void {
    this.inputLength = this.inputPosition = this.remaining = 0;
    this.outputLength = this.outputPosition = 0;
    this.command = 0;
    this.enableIn = this.enableOut = false;
  }

  private get depth(): number {
    return (this.command >>> 27) & 3;
  }

  readStatus(): number {
    let status = 0;
    if (this.available() === 0) status |= STATUS_OUT_EMPTY;
    if (this.remaining > 0 || this.available() > 0) status |= STATUS_BUSY;
    if (this.enableIn && this.remaining > 0) status |= STATUS_IN_REQUEST;
    if (this.enableOut && this.available() > 0) status |= STATUS_OUT_REQUEST;
    status |= ((this.command >>> 25) & 0xf) << 23;
    status |= 4 << 16;
    status |= (this.remaining - 1) & 0xffff;
    return status >>> 0;
  }

  writeControl(value: number): void {
    if (value & 0x80000000) this.reset();
    this.enableIn = (value & 0x40000000) !== 0;
    this.enableOut = (value & 0x20000000) !== 0;
  }

  /** A decode command is still taking input. */
  get busy(): boolean {
    return this.remaining > 0;
  }

  available(): number {
    return this.outputLength - this.outputPosition;
  }

  readData(): number {
    if (this.outputPosition >= this.outputLength) return 0;
    const word = this.output[this.outputPosition++];
    if (this.outputPosition === this.outputLength) this.outputPosition = this.outputLength = 0;
    return word;
  }

  /** A word written to the command/parameter register (by the CPU or DMA0). */
  writeCommand(word: number): void {
    word >>>= 0;
    if (this.remaining === 0) {
      this.command = word;
      this.inputLength = this.inputPosition = 0;
      switch (word >>> 29) {
        case 1:
          this.remaining = word & 0xffff;
          break;
        case 2:
          this.remaining = word & 1 ? 32 : 16;
          break;
        case 3:
          this.remaining = 32;
          break;
        default:
          this.remaining = 0;
      }
      return;
    }
    this.remaining--;
    if (this.inputLength + 2 > this.input.length) {
      const bigger = new Uint16Array(this.input.length * 2);
      bigger.set(this.input);
      this.input = bigger;
    }
    this.input[this.inputLength++] = word & 0xffff;
    this.input[this.inputLength++] = word >>> 16;
    switch (this.command >>> 29) {
      case 1:
        if (this.remaining === 0 || (this.inputLength - this.inputPosition) >= 0x200) this.decode();
        break;
      case 2:
        if (this.remaining === 0) this.setQuantTables();
        break;
      case 3:
        if (this.remaining === 0) this.scaleTable.set(new Int16Array(this.input.buffer, 0, 64));
        break;
    }
  }

  /** Decodes as many complete macroblocks as the input holds. */
  decode(): void {
    const before = this.available();
    const color = this.depth >= 2;
    for (;;) {
      const start = this.inputPosition;
      const ok = color ? this.decodeColorMacroblock() : this.decodeMonoBlock();
      if (!ok) {
        this.inputPosition = start;
        break;
      }
    }
    if (this.remaining === 0) this.inputLength = this.inputPosition = 0;
    if (this.available() > before) this.onOutput();
  }

  private setQuantTables(): void {
    const bytes = new Uint8Array(this.input.buffer, 0, this.inputLength * 2);
    this.luminanceTable.set(bytes.subarray(0, 64));
    if (this.command & 1) this.colorTable.set(bytes.subarray(64, 128));
  }

  /** Reads one block's coefficients; false if the input runs out first. */
  private readBlock(block: Int16Array, table: Uint8Array): boolean {
    const input = this.input;
    let position = this.inputPosition;
    const end = this.inputLength;
    block.fill(0);
    let n: number;
    do {
      if (position >= end) return false;
      n = input[position++];
    } while (n === 0xfe00);
    // The first halfword holds the quantiser scale and the DC coefficient; the rest are
    // (zero run, value) pairs. A block ends at FE00h, or as soon as coefficient 63 is stored.
    let k = 0;
    const scale = (n >> 10) & 0x3f;
    let value = signed10(n & 0x3ff) * table[0];
    for (;;) {
      if (scale === 0) value = signed10(n & 0x3ff) * 2;
      value = value < -0x400 ? -0x400 : value > 0x3ff ? 0x3ff : value;
      if (scale > 0) block[ZAGZIG[k]] = value;
      else block[k] = value;
      if (k >= 63) break;
      if (position >= end) return false;
      n = input[position++];
      k += ((n >> 10) & 0x3f) + 1;
      if (k > 63) break;
      value = Math.trunc((signed10(n & 0x3ff) * table[k] * scale + 4) / 8);
    }
    this.inputPosition = position;
    this.idct(block);
    return true;
  }

  /** The two-pass IDCT with the uploaded scale table, rounding as the hardware does. */
  private idct(block: Int16Array): void {
    const scale = this.scaleTable;
    const temp = this.temp;
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += block[u * 8 + x] * scale[u * 8 + y];
        temp[x + y * 8] = sum;
      }
    }
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += temp[u + y * 8] * scale[u * 8 + x];
        const rounded = Math.floor(sum / TWO_32) + (Math.floor(sum / TWO_31) & 1);
        block[x + y * 8] = clampByte(signed9(rounded));
      }
    }
  }

  private decodeColorMacroblock(): boolean {
    const [cr, cb, y1, y2, y3, y4] = this.blocks;
    if (!this.readBlock(cr, this.colorTable)) return false;
    if (!this.readBlock(cb, this.colorTable)) return false;
    if (!this.readBlock(y1, this.luminanceTable)) return false;
    if (!this.readBlock(y2, this.luminanceTable)) return false;
    if (!this.readBlock(y3, this.luminanceTable)) return false;
    if (!this.readBlock(y4, this.luminanceTable)) return false;
    this.toRgb(0, 0, cr, cb, y1);
    this.toRgb(8, 0, cr, cb, y2);
    this.toRgb(0, 8, cr, cb, y3);
    this.toRgb(8, 8, cr, cb, y4);
    this.emitColor();
    return true;
  }

  private toRgb(xx: number, yy: number, cr: Int16Array, cb: Int16Array, luma: Int16Array): void {
    const add = this.command & (1 << 26) ? 0 : 0x80;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        // Fixed-point YCbCr to RGB as the hardware rounds it (1.402, 0.344, 0.714 and 1.772 in 8.8).
        const chroma = ((x + xx) >> 1) + ((y + yy) >> 1) * 8;
        const red = cr[chroma];
        const blue = cb[chroma];
        const y0 = luma[x + y * 8];
        const r = (clampByte(signed9(y0 + ((359 * red + 0x80) >> 8))) + add) & 0xff;
        const g = (clampByte(signed9(y0 + ((((-88 * blue) & ~0x1f) + ((-183 * red) & ~0x07) + 0x80) >> 8))) + add) & 0xff;
        const b = (clampByte(signed9(y0 + ((454 * blue + 0x80) >> 8))) + add) & 0xff;
        this.rgb[x + xx + (y + yy) * 16] = r | (g << 8) | (b << 16);
      }
    }
  }

  private ensureOutput(words: number): void {
    if (this.outputLength + words <= this.output.length) return;
    const live = this.output.subarray(this.outputPosition, this.outputLength);
    const bigger = new Uint32Array(Math.max(this.output.length, (live.length + words) * 2));
    bigger.set(live);
    this.output = bigger;
    this.outputLength = live.length;
    this.outputPosition = 0;
  }

  private emitColor(): void {
    const rgb = this.rgb;
    if (this.depth === 2) {
      // 24-bit: 768 bytes, packed little-endian into 192 words.
      this.ensureOutput(192);
      let word = 0;
      let shift = 0;
      for (let i = 0; i < 256; i++) {
        const pixel = rgb[i];
        for (let c = 0; c < 3; c++) {
          word |= ((pixel >> (c * 8)) & 0xff) << shift;
          shift += 8;
          if (shift === 32) {
            this.output[this.outputLength++] = word >>> 0;
            word = shift = 0;
          }
        }
      }
      return;
    }
    this.ensureOutput(128);
    const bit15 = this.command & (1 << 25) ? 0x8000 : 0;
    // 8-bit components are rounded to 5 bits.
    const c5 = (value: number) => Math.min(31, (value + 4) >> 3);
    const to15 = (p: number) => c5(p & 0xff) | (c5((p >> 8) & 0xff) << 5) | (c5((p >> 16) & 0xff) << 10) | bit15;
    for (let i = 0; i < 256; i += 2) this.output[this.outputLength++] = (to15(rgb[i]) | (to15(rgb[i + 1]) << 16)) >>> 0;
  }

  private decodeMonoBlock(): boolean {
    const block = this.blocks[2];
    if (!this.readBlock(block, this.luminanceTable)) return false;
    const add = this.command & (1 << 26) ? 0 : 0x80;
    if (this.depth === 1) {
      this.ensureOutput(16);
      for (let i = 0; i < 64; i += 4) {
        let word = 0;
        for (let j = 0; j < 4; j++) word |= ((block[i + j] + add) & 0xff) << (j * 8);
        this.output[this.outputLength++] = word >>> 0;
      }
    } else {
      this.ensureOutput(8);
      for (let i = 0; i < 64; i += 8) {
        let word = 0;
        for (let j = 0; j < 8; j++) word |= (((block[i + j] + add) & 0xff) >> 4) << (j * 4);
        this.output[this.outputLength++] = word >>> 0;
      }
    }
    return true;
  }
}
