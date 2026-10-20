// A synchronous LZMA decoder (the raw LZMA1 stream, no header), as CHD's "cdlz" codec
// stores CD sectors: lc=3, lp=0, pb=2, with the output size known.

const NUM_STATES = 12;
const POS_STATES_MAX = 16;
const LEN_LOW_SYMBOLS = 8;
const LEN_MID_SYMBOLS = 8;
const LEN_HIGH_SYMBOLS = 256;
const END_POS_MODEL_INDEX = 14;
const NUM_FULL_DISTANCES = 128;
const ALIGN_BITS = 4;
const MATCH_MIN_LEN = 2;

class RangeDecoder {
  range = 0xffffffff;
  code = 0;
  position: number;

  constructor(
    private readonly input: Uint8Array,
    start: number,
  ) {
    this.position = start + 1; // the first byte is always 0
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
  }

  private byte(): number {
    return this.position < this.input.length ? this.input[this.position++] : 0;
  }

  private normalize(): void {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }

  bit(probs: Uint16Array, index: number): number {
    const p = probs[index];
    const bound = (this.range >>> 11) * p;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[index] = p + ((2048 - p) >>> 5);
      bit = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probs[index] = p - (p >>> 5);
      bit = 1;
    }
    this.normalize();
    return bit;
  }

  direct(count: number): number {
    let result = 0;
    for (let i = 0; i < count; i++) {
      this.range >>>= 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      result = ((result << 1) | bit) >>> 0;
      this.normalize();
    }
    return result;
  }

  tree(probs: Uint16Array, offset: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(probs, offset + m);
    return m - (1 << bits);
  }

  reverseTree(probs: Uint16Array, offset: number, bits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < bits; i++) {
      const bit = this.bit(probs, offset + m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }
}

class LengthDecoder {
  private readonly choice = new Uint16Array(2).fill(1024);
  private readonly low = new Uint16Array(POS_STATES_MAX << 3).fill(1024);
  private readonly mid = new Uint16Array(POS_STATES_MAX << 3).fill(1024);
  private readonly high = new Uint16Array(LEN_HIGH_SYMBOLS).fill(1024);

  decode(rc: RangeDecoder, posState: number): number {
    if (rc.bit(this.choice, 0) === 0) return rc.tree(this.low, posState << 3, 3);
    if (rc.bit(this.choice, 1) === 0) return LEN_LOW_SYMBOLS + rc.tree(this.mid, posState << 3, 3);
    return LEN_LOW_SYMBOLS + LEN_MID_SYMBOLS + rc.tree(this.high, 0, 8);
  }
}

/** Decodes an LZMA stream (starting at `start`) until `out` is full. */
export function decodeLzma(input: Uint8Array, start: number, out: Uint8Array, lc = 3, lp = 0, pb = 2): void {
  const rc = new RangeDecoder(input, start);
  const literalProbs = new Uint16Array(0x300 << (lc + lp)).fill(1024);
  const isMatch = new Uint16Array(NUM_STATES << 4).fill(1024);
  const isRep = new Uint16Array(NUM_STATES).fill(1024);
  const isRepG0 = new Uint16Array(NUM_STATES).fill(1024);
  const isRepG1 = new Uint16Array(NUM_STATES).fill(1024);
  const isRepG2 = new Uint16Array(NUM_STATES).fill(1024);
  const isRep0Long = new Uint16Array(NUM_STATES << 4).fill(1024);
  const posSlot = new Uint16Array(4 << 6).fill(1024);
  const posDecoders = new Uint16Array(1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX).fill(1024);
  const align = new Uint16Array(1 << ALIGN_BITS).fill(1024);
  const lengths = new LengthDecoder();
  const repLengths = new LengthDecoder();
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let written = 0;
  const size = out.length;

  while (written < size) {
    const posState = written & pbMask;
    if (rc.bit(isMatch, (state << 4) + posState) === 0) {
      const previous = written > 0 ? out[written - 1] : 0;
      const base = 0x300 * (((written & lpMask) << lc) + (previous >> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let matchByte = out[written - rep0 - 1];
        do {
          const matchBit = (matchByte >> 7) & 1;
          matchByte <<= 1;
          const bit = rc.bit(literalProbs, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(literalProbs, base + symbol);
      out[written++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let length: number;
    if (rc.bit(isRep, state) !== 0) {
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << 4) + posState) === 0) {
          // A single byte from rep0.
          state = state < 7 ? 9 : 11;
          out[written] = out[written - rep0 - 1];
          written++;
          continue;
        }
      } else {
        let distance: number;
        if (rc.bit(isRepG1, state) === 0) distance = rep1;
        else {
          if (rc.bit(isRepG2, state) === 0) distance = rep2;
          else {
            distance = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }
      length = repLengths.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      length = lengths.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      const lenState = Math.min(length, 3);
      const slot = rc.tree(posSlot, lenState << 6, 6);
      if (slot < 4) rep0 = slot;
      else {
        const directBits = (slot >> 1) - 1;
        rep0 = (2 | (slot & 1)) << directBits;
        if (slot < END_POS_MODEL_INDEX) rep0 += rc.reverseTree(posDecoders, rep0 - slot - 1, directBits);
        else {
          rep0 += rc.direct(directBits - ALIGN_BITS) << ALIGN_BITS;
          rep0 += rc.reverseTree(align, 0, ALIGN_BITS);
        }
        rep0 >>>= 0;
        if (rep0 === 0xffffffff) break; // end marker
      }
    }
    length += MATCH_MIN_LEN;
    if (rep0 >= written) throw new Error('Damaged compressed data (LZMA distance).');
    for (let i = 0; i < length && written < size; i++, written++) out[written] = out[written - rep0 - 1];
  }
}
