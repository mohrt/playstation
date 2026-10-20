/**
 * The GTE (COP2): fixed-point vector and matrix maths for 3D. Results go
 * through 44-bit accumulators (MAC1-3), 32-bit MAC0 and saturated 16-bit IR
 * registers, and every overflow and saturation sets a FLAG bit. Values are
 * held as plain numbers; products fit easily within a double's 53 bits.
 */

/** The reciprocal table used by the perspective division (unr_table in psx-spx). */
const UNR_TABLE = Uint8Array.from({ length: 0x101 }, (_, i) => Math.max(0, Math.floor((Math.floor(0x40000 / (i + 0x100)) + 1) / 2) - 0x101));

const TWO_43 = 2 ** 43;
const TWO_44 = 2 ** 44;
const TWO_31 = 2 ** 31;
const TWO_32 = 2 ** 32;

/** Cycles each command takes, by function number. */
const COMMAND_CYCLES: Record<number, number> = {
  0x01: 15,
  0x06: 8,
  0x0c: 6,
  0x10: 8,
  0x11: 8,
  0x12: 8,
  0x13: 19,
  0x14: 13,
  0x16: 44,
  0x1b: 17,
  0x1c: 11,
  0x1e: 14,
  0x20: 30,
  0x28: 5,
  0x29: 8,
  0x2a: 17,
  0x2d: 5,
  0x2e: 6,
  0x30: 23,
  0x3d: 5,
  0x3e: 5,
  0x3f: 39,
};

const s16 = (value: number) => (value << 16) >> 16;
const lo16 = (value: number) => s16(value);
const hi16 = (value: number) => value >> 16;
const pack = (low: number, high: number) => (low & 0xffff) | (high << 16);
/** Arithmetic shift right of a (possibly beyond 32-bit) integer. */
const sar = (value: number, shift: number) => (shift === 0 ? value : Math.floor(value / 2 ** shift));

export class Gte {
  // Data registers
  readonly v = new Int32Array(9); // VX0, VY0, VZ0, VX1, ...
  rgbc = 0;
  otz = 0;
  readonly ir = new Int32Array(4);
  readonly sx = new Int32Array(3);
  readonly sy = new Int32Array(3);
  readonly sz = new Int32Array(4);
  readonly rgbFifo = new Int32Array(3);
  res1 = 0;
  readonly mac = new Int32Array(4);
  lzcs = 0;
  lzcr = 32;

  // Control registers
  readonly rt = new Int32Array(9);
  readonly tr = new Int32Array(3);
  readonly llm = new Int32Array(9);
  readonly bk = new Int32Array(3);
  readonly lcm = new Int32Array(9);
  readonly fc = new Int32Array(3);
  ofx = 0;
  ofy = 0;
  h = 0;
  dqa = 0;
  dqb = 0;
  zsf3 = 0;
  zsf4 = 0;
  flag = 0;

  // The current command's fields.
  private shift = 0;
  private lm = false;

  reset(): void {
    this.v.fill(0);
    this.rgbc = this.otz = this.res1 = this.lzcs = 0;
    this.lzcr = 32;
    for (const array of [this.ir, this.sx, this.sy, this.sz, this.rgbFifo, this.mac, this.rt, this.tr, this.llm, this.bk, this.lcm, this.fc]) array.fill(0);
    this.ofx = this.ofy = this.h = this.dqa = this.dqb = this.zsf3 = this.zsf4 = this.flag = 0;
  }

  readData(reg: number): number {
    switch (reg) {
      case 0:
        return pack(this.v[0], this.v[1]);
      case 1:
        return this.v[2];
      case 2:
        return pack(this.v[3], this.v[4]);
      case 3:
        return this.v[5];
      case 4:
        return pack(this.v[6], this.v[7]);
      case 5:
        return this.v[8];
      case 6:
        return this.rgbc;
      case 7:
        return this.otz;
      case 8:
      case 9:
      case 10:
      case 11:
        return this.ir[reg - 8];
      case 12:
      case 13:
      case 14:
        return pack(this.sx[reg - 12], this.sy[reg - 12]);
      case 15:
        return pack(this.sx[2], this.sy[2]);
      case 16:
      case 17:
      case 18:
      case 19:
        return this.sz[reg - 16];
      case 20:
      case 21:
      case 22:
        return this.rgbFifo[reg - 20];
      case 23:
        return this.res1;
      case 24:
      case 25:
      case 26:
      case 27:
        return this.mac[reg - 24];
      case 28:
      case 29:
        return this.orgb();
      case 30:
        return this.lzcs;
      default:
        return this.lzcr;
    }
  }

  private orgb(): number {
    const c = (value: number) => Math.min(0x1f, Math.max(0, value >> 7));
    return c(this.ir[1]) | (c(this.ir[2]) << 5) | (c(this.ir[3]) << 10);
  }

  writeData(reg: number, value: number): void {
    value |= 0;
    switch (reg) {
      case 0:
      case 2:
      case 4: {
        const i = (reg >> 1) * 3;
        this.v[i] = lo16(value);
        this.v[i + 1] = hi16(value);
        return;
      }
      case 1:
      case 3:
      case 5:
        this.v[(reg >> 1) * 3 + 2] = lo16(value);
        return;
      case 6:
        this.rgbc = value;
        return;
      case 7:
        this.otz = value & 0xffff;
        return;
      case 8:
      case 9:
      case 10:
      case 11:
        this.ir[reg - 8] = lo16(value);
        return;
      case 12:
      case 13:
      case 14:
        this.sx[reg - 12] = lo16(value);
        this.sy[reg - 12] = hi16(value);
        return;
      case 15:
        this.pushScreenXy(lo16(value), hi16(value));
        return;
      case 16:
      case 17:
      case 18:
      case 19:
        this.sz[reg - 16] = value & 0xffff;
        return;
      case 20:
      case 21:
      case 22:
        this.rgbFifo[reg - 20] = value;
        return;
      case 23:
        this.res1 = value;
        return;
      case 24:
      case 25:
      case 26:
      case 27:
        this.mac[reg - 24] = value;
        return;
      case 28:
        this.ir[1] = (value & 0x1f) << 7;
        this.ir[2] = ((value >> 5) & 0x1f) << 7;
        this.ir[3] = ((value >> 10) & 0x1f) << 7;
        return;
      case 29:
        return;
      case 30:
        this.lzcs = value;
        this.lzcr = Math.clz32(value < 0 ? ~value : value);
        return;
      default:
        return;
    }
  }

  readControl(reg: number): number {
    switch (reg) {
      case 0:
        return pack(this.rt[0], this.rt[1]);
      case 1:
        return pack(this.rt[2], this.rt[3]);
      case 2:
        return pack(this.rt[4], this.rt[5]);
      case 3:
        return pack(this.rt[6], this.rt[7]);
      case 4:
        return this.rt[8];
      case 5:
      case 6:
      case 7:
        return this.tr[reg - 5];
      case 8:
        return pack(this.llm[0], this.llm[1]);
      case 9:
        return pack(this.llm[2], this.llm[3]);
      case 10:
        return pack(this.llm[4], this.llm[5]);
      case 11:
        return pack(this.llm[6], this.llm[7]);
      case 12:
        return this.llm[8];
      case 13:
      case 14:
      case 15:
        return this.bk[reg - 13];
      case 16:
        return pack(this.lcm[0], this.lcm[1]);
      case 17:
        return pack(this.lcm[2], this.lcm[3]);
      case 18:
        return pack(this.lcm[4], this.lcm[5]);
      case 19:
        return pack(this.lcm[6], this.lcm[7]);
      case 20:
        return this.lcm[8];
      case 21:
      case 22:
      case 23:
        return this.fc[reg - 21];
      case 24:
        return this.ofx;
      case 25:
        return this.ofy;
      case 26:
        // H reads back sign-extended, though it is used unsigned.
        return s16(this.h);
      case 27:
        return this.dqa;
      case 28:
        return this.dqb;
      case 29:
        return this.zsf3;
      case 30:
        return this.zsf4;
      default:
        return this.flagValue();
    }
  }

  writeControl(reg: number, value: number): void {
    value |= 0;
    const matrix = (m: Int32Array, i: number) => {
      m[i] = lo16(value);
      m[i + 1] = hi16(value);
    };
    switch (reg) {
      case 0:
      case 1:
      case 2:
      case 3:
        return matrix(this.rt, reg * 2);
      case 4:
        this.rt[8] = lo16(value);
        return;
      case 5:
      case 6:
      case 7:
        this.tr[reg - 5] = value;
        return;
      case 8:
      case 9:
      case 10:
      case 11:
        return matrix(this.llm, (reg - 8) * 2);
      case 12:
        this.llm[8] = lo16(value);
        return;
      case 13:
      case 14:
      case 15:
        this.bk[reg - 13] = value;
        return;
      case 16:
      case 17:
      case 18:
      case 19:
        return matrix(this.lcm, (reg - 16) * 2);
      case 20:
        this.lcm[8] = lo16(value);
        return;
      case 21:
      case 22:
      case 23:
        this.fc[reg - 21] = value;
        return;
      case 24:
        this.ofx = value;
        return;
      case 25:
        this.ofy = value;
        return;
      case 26:
        this.h = value & 0xffff;
        return;
      case 27:
        this.dqa = lo16(value);
        return;
      case 28:
        this.dqb = value;
        return;
      case 29:
        this.zsf3 = lo16(value);
        return;
      case 30:
        this.zsf4 = lo16(value);
        return;
      default:
        this.flag = value & 0x7ffff000;
    }
  }

  private flagValue(): number {
    const flag = this.flag & 0x7ffff000;
    return flag & 0x7f87e000 ? flag | 0x80000000 : flag;
  }

  /** Runs a GTE command; returns the cycles it takes. */
  command(op: number): number {
    this.shift = op & (1 << 19) ? 12 : 0;
    this.lm = (op & (1 << 10)) !== 0;
    this.flag = 0;
    const fn = op & 0x3f;
    switch (fn) {
      case 0x01:
        this.rtp(0, true);
        break;
      case 0x06:
        this.nclip();
        break;
      case 0x0c:
        this.outerProduct();
        break;
      case 0x10:
        this.dpcs(this.rgbc);
        break;
      case 0x11:
        this.interpolateColor(this.ir[1] * 4096, this.ir[2] * 4096, this.ir[3] * 4096);
        break;
      case 0x12:
        this.mvmva(op);
        break;
      case 0x13:
        this.ncd(0);
        break;
      case 0x14:
        this.cdp();
        break;
      case 0x16:
        this.ncd(0);
        this.ncd(1);
        this.ncd(2);
        break;
      case 0x1b:
        this.ncc(0);
        break;
      case 0x1c:
        this.cc();
        break;
      case 0x1e:
        this.nc(0);
        break;
      case 0x20:
        this.nc(0);
        this.nc(1);
        this.nc(2);
        break;
      case 0x28:
        this.sqr();
        break;
      case 0x29:
        this.dcpl();
        break;
      case 0x2a:
        this.dpcs(this.rgbFifo[0]);
        this.dpcs(this.rgbFifo[0]);
        this.dpcs(this.rgbFifo[0]);
        break;
      case 0x2d:
        this.averageZ(this.zsf3, this.sz[1] + this.sz[2] + this.sz[3]);
        break;
      case 0x2e:
        this.averageZ(this.zsf4, this.sz[0] + this.sz[1] + this.sz[2] + this.sz[3]);
        break;
      case 0x30:
        this.rtp(0, false);
        this.rtp(1, false);
        this.rtp(2, true);
        break;
      case 0x3d:
        this.gpf();
        break;
      case 0x3e:
        this.gpl();
        break;
      case 0x3f:
        this.ncc(0);
        this.ncc(1);
        this.ncc(2);
        break;
      default:
        break;
    }
    this.flag = this.flagValue();
    return COMMAND_CYCLES[fn] ?? 2;
  }

  // --- Saturation and overflow -------------------------------------------------------

  /** Sets MAC1-3's overflow flags for a sum beyond 44 bits. */
  private flagMac(i: number, value: number): void {
    if (value >= TWO_43) this.flag |= 1 << (31 - i);
    else if (value < -TWO_43) this.flag |= 1 << (28 - i);
  }

  /** An intermediate MAC1-3 sum: flagged, then wrapped to 44 bits as the accumulator holds it. */
  private checkMac(i: number, value: number): number {
    if (value >= TWO_43 || value < -TWO_43) {
      this.flagMac(i, value);
      return value - TWO_44 * Math.floor((value + TWO_43) / TWO_44);
    }
    return value;
  }

  private checkMac0(value: number): number {
    if (value >= TWO_31) this.flag |= 1 << 16;
    else if (value < -TWO_31) this.flag |= 1 << 15;
    return value;
  }

  private setMac0(value: number): void {
    this.mac[0] = this.checkMac0(value) % TWO_32 | 0;
  }

  /** Saturates to IR1-3's range, setting the flag. */
  private clampIr(i: number, value: number, lm: boolean): number {
    const min = lm ? 0 : -0x8000;
    if (value > 0x7fff) {
      this.flag |= 1 << (25 - i);
      return 0x7fff;
    }
    if (value < min) {
      this.flag |= 1 << (25 - i);
      return min;
    }
    return value;
  }

  /** A final MAC1-3 result: flagged, shifted, cut to 32 bits; IR is that value saturated. */
  private setMacIr(i: number, value: number, lm: boolean): void {
    this.flagMac(i, value);
    const mac = sar(value, this.shift) | 0;
    this.mac[i] = mac;
    this.ir[i] = this.clampIr(i, mac, lm);
  }

  private clampColor(i: number, value: number): number {
    if (value < 0) {
      this.flag |= 1 << (22 - i);
      return 0;
    }
    if (value > 0xff) {
      this.flag |= 1 << (22 - i);
      return 0xff;
    }
    return value;
  }

  /** Pushes MAC1-3 / 16 as a colour onto the colour FIFO, with RGBC's code byte. */
  private pushColor(): void {
    const r = this.clampColor(1, this.mac[1] >> 4);
    const g = this.clampColor(2, this.mac[2] >> 4);
    const b = this.clampColor(3, this.mac[3] >> 4);
    this.rgbFifo[0] = this.rgbFifo[1];
    this.rgbFifo[1] = this.rgbFifo[2];
    this.rgbFifo[2] = r | (g << 8) | (b << 16) | (this.rgbc & 0xff000000);
  }

  private pushScreenXy(x: number, y: number): void {
    this.sx[0] = this.sx[1];
    this.sy[0] = this.sy[1];
    this.sx[1] = this.sx[2];
    this.sy[1] = this.sy[2];
    this.sx[2] = x;
    this.sy[2] = y;
  }

  private pushZ(value: number): void {
    if (value < 0) {
      value = 0;
      this.flag |= 1 << 18;
    } else if (value > 0xffff) {
      value = 0xffff;
      this.flag |= 1 << 18;
    }
    this.sz[0] = this.sz[1];
    this.sz[1] = this.sz[2];
    this.sz[2] = this.sz[3];
    this.sz[3] = value;
  }

  // --- Commands ------------------------------------------------------------------

  /** Translation × 1000h + matrix row × vector, wrapping to 44 bits after each step but the last. */
  private multiplyAdd(i: number, translation: number, m0: number, v0: number, m1: number, v1: number, m2: number, v2: number): number {
    let sum = this.checkMac(i, translation * 4096);
    sum = this.checkMac(i, sum + m0 * v0);
    sum = this.checkMac(i, sum + m1 * v1);
    return sum + m2 * v2;
  }

  /** RTPS/RTPT: rotates, translates and projects vertex `n`. */
  private rtp(n: number, last: boolean): void {
    const { rt, tr, v } = this;
    const vx = v[n * 3];
    const vy = v[n * 3 + 1];
    const vz = v[n * 3 + 2];
    const x = this.multiplyAdd(1, tr[0], rt[0], vx, rt[1], vy, rt[2], vz);
    const y = this.multiplyAdd(2, tr[1], rt[3], vx, rt[4], vy, rt[5], vz);
    const z = this.multiplyAdd(3, tr[2], rt[6], vx, rt[7], vy, rt[8], vz);
    this.setMacIr(1, x, this.lm);
    this.setMacIr(2, y, this.lm);
    // IR3 saturates on MAC3, but its flag follows MAC3 >> 12 whatever the shift.
    this.flagMac(3, z);
    const mac3 = sar(z, this.shift) | 0;
    this.mac[3] = mac3;
    const z12 = sar(z, 12) | 0;
    const min = this.lm ? 0 : -0x8000;
    this.ir[3] = Math.min(0x7fff, Math.max(min, mac3));
    if (z12 > 0x7fff || z12 < -0x8000) this.flag |= 1 << 22;
    this.pushZ(z12);

    const divisor = this.divide();
    const sx = divisor * this.ir[1] + this.ofx;
    const sy = divisor * this.ir[2] + this.ofy;
    this.setMac0(sx);
    this.checkMac0(sy);
    this.mac[0] = sy % TWO_32 | 0;
    this.pushScreenXy(this.clampScreen(sar(sx, 16), 14), this.clampScreen(sar(sy, 16), 13));
    if (last) {
      const depth = divisor * this.dqa + this.dqb;
      this.setMac0(depth);
      let ir0 = sar(depth, 12);
      if (ir0 < 0) {
        ir0 = 0;
        this.flag |= 1 << 12;
      } else if (ir0 > 0x1000) {
        ir0 = 0x1000;
        this.flag |= 1 << 12;
      }
      this.ir[0] = ir0;
    }
  }

  private clampScreen(value: number, flagBit: number): number {
    if (value < -0x400) {
      this.flag |= 1 << flagBit;
      return -0x400;
    }
    if (value > 0x3ff) {
      this.flag |= 1 << flagBit;
      return 0x3ff;
    }
    return value;
  }

  /** H / SZ3 as the hardware works it out (Newton-Raphson from a table), saturated to 0x1FFFF. */
  private divide(): number {
    const h = this.h;
    const z = this.sz[3];
    if (h >= z * 2) {
      this.flag |= 1 << 17;
      return 0x1ffff;
    }
    const shift = Math.clz32(z) - 16;
    const n = h * 2 ** shift;
    let d = z << shift;
    const u = UNR_TABLE[(d - 0x7fc0) >> 7] + 0x101;
    d = (0x2000080 - d * u) >> 8;
    d = (0x0000080 + d * u) >> 8;
    return Math.min(0x1ffff, Math.floor((n * d + 0x8000) / 0x10000));
  }

  private nclip(): void {
    const { sx, sy } = this;
    this.setMac0(sx[0] * sy[1] + sx[1] * sy[2] + sx[2] * sy[0] - sx[0] * sy[2] - sx[1] * sy[0] - sx[2] * sy[1]);
  }

  private outerProduct(): void {
    const d1 = this.rt[0];
    const d2 = this.rt[4];
    const d3 = this.rt[8];
    const [, ir1, ir2, ir3] = this.ir;
    this.setMacIr(1, ir3 * d2 - ir2 * d3, this.lm);
    this.setMacIr(2, ir1 * d3 - ir3 * d1, this.lm);
    this.setMacIr(3, ir2 * d1 - ir1 * d2, this.lm);
  }

  /** MAC = in + (FC - in) × IR0, then a colour push (DPCS, DPCT, INTPL, DCPL, NCDx, CDP). */
  private interpolateColor(in1: number, in2: number, in3: number): void {
    const { fc } = this;
    this.setMacIr(1, fc[0] * 4096 - in1, false);
    this.setMacIr(2, fc[1] * 4096 - in2, false);
    this.setMacIr(3, fc[2] * 4096 - in3, false);
    const ir0 = this.ir[0];
    this.setMacIr(1, this.ir[1] * ir0 + in1, this.lm);
    this.setMacIr(2, this.ir[2] * ir0 + in2, this.lm);
    this.setMacIr(3, this.ir[3] * ir0 + in3, this.lm);
    this.pushColor();
  }

  private dpcs(color: number): void {
    this.interpolateColor((color & 0xff) * 0x10000, ((color >> 8) & 0xff) * 0x10000, ((color >> 16) & 0xff) * 0x10000);
  }

  private dcpl(): void {
    const c = this.rgbc;
    this.interpolateColor((c & 0xff) * 16 * this.ir[1], ((c >> 8) & 0xff) * 16 * this.ir[2], ((c >> 16) & 0xff) * 16 * this.ir[3]);
  }

  private mvmva(op: number): void {
    const mx = (op >> 17) & 3;
    const vi = (op >> 15) & 3;
    const cv = (op >> 13) & 3;
    let m: ArrayLike<number>;
    if (mx === 0) m = this.rt;
    else if (mx === 1) m = this.llm;
    else if (mx === 2) m = this.lcm;
    else {
      // The missing fourth matrix reads as garbage made of other registers.
      const r = (this.rgbc & 0xff) << 4;
      m = [-r, r, this.ir[0], this.rt[2], this.rt[2], this.rt[2], this.rt[4], this.rt[4], this.rt[4]];
    }
    let vx: number, vy: number, vz: number;
    if (vi === 3) {
      vx = this.ir[1];
      vy = this.ir[2];
      vz = this.ir[3];
    } else {
      vx = this.v[vi * 3];
      vy = this.v[vi * 3 + 1];
      vz = this.v[vi * 3 + 2];
    }
    const t = cv === 0 ? this.tr : cv === 1 ? this.bk : cv === 2 ? this.fc : [0, 0, 0];
    if (cv === 2) {
      // With the far colour as translation, the first column's sum only sets flags; the result drops it.
      for (let i = 0; i < 3; i++) {
        const first = this.checkMac(i + 1, this.checkMac(i + 1, t[i] * 4096) + m[i * 3] * vx);
        this.clampIr(i + 1, sar(first, this.shift) | 0, false);
        const sum = this.checkMac(i + 1, m[i * 3 + 1] * vy);
        this.setMacIr(i + 1, this.checkMac(i + 1, sum + m[i * 3 + 2] * vz), this.lm);
      }
      return;
    }
    for (let i = 0; i < 3; i++) {
      this.setMacIr(i + 1, this.multiplyAdd(i + 1, t[i], m[i * 3], vx, m[i * 3 + 1], vy, m[i * 3 + 2], vz), this.lm);
    }
  }

  /** IR = MAC = (LLM × Vn) >> shift: the light vectors' dot products with the normal. */
  private lightVector(n: number): void {
    const { llm, v } = this;
    const vx = v[n * 3];
    const vy = v[n * 3 + 1];
    const vz = v[n * 3 + 2];
    for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.multiplyAdd(i + 1, 0, llm[i * 3], vx, llm[i * 3 + 1], vy, llm[i * 3 + 2], vz), this.lm);
  }

  /** IR = MAC = (BK × 1000h + LCM × IR) >> shift: the light colours. */
  private lightColor(): void {
    const { lcm, bk } = this;
    const [, ir1, ir2, ir3] = this.ir;
    for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.multiplyAdd(i + 1, bk[i], lcm[i * 3], ir1, lcm[i * 3 + 1], ir2, lcm[i * 3 + 2], ir3), this.lm);
  }

  /** [R × IR1, G × IR2, B × IR3] << 4: the vertex colour lit. */
  private colorTimesIr(): [number, number, number] {
    const c = this.rgbc;
    return [(c & 0xff) * 16 * this.ir[1], ((c >> 8) & 0xff) * 16 * this.ir[2], ((c >> 16) & 0xff) * 16 * this.ir[3]];
  }

  private nc(n: number): void {
    this.lightVector(n);
    this.lightColor();
    this.pushColor();
  }

  private ncc(n: number): void {
    this.lightVector(n);
    this.cc();
  }

  private cc(): void {
    this.lightColor();
    const [r, g, b] = this.colorTimesIr();
    this.setMacIr(1, r, this.lm);
    this.setMacIr(2, g, this.lm);
    this.setMacIr(3, b, this.lm);
    this.pushColor();
  }

  private ncd(n: number): void {
    this.lightVector(n);
    this.cdp();
  }

  private cdp(): void {
    this.lightColor();
    const [r, g, b] = this.colorTimesIr();
    this.interpolateColor(r, g, b);
  }

  private sqr(): void {
    for (let i = 1; i <= 3; i++) this.setMacIr(i, this.ir[i] * this.ir[i], this.lm);
  }

  private averageZ(factor: number, sum: number): void {
    const value = factor * sum;
    this.setMac0(value);
    const otz = sar(value, 12);
    if (otz < 0) {
      this.otz = 0;
      this.flag |= 1 << 18;
    } else if (otz > 0xffff) {
      this.otz = 0xffff;
      this.flag |= 1 << 18;
    } else {
      this.otz = otz;
    }
  }

  private gpf(): void {
    const ir0 = this.ir[0];
    for (let i = 1; i <= 3; i++) this.setMacIr(i, this.ir[i] * ir0, this.lm);
    this.pushColor();
  }

  private gpl(): void {
    const ir0 = this.ir[0];
    const scale = 2 ** this.shift;
    for (let i = 1; i <= 3; i++) this.setMacIr(i, this.mac[i] * scale + this.ir[i] * ir0, this.lm);
    this.pushColor();
  }
}
