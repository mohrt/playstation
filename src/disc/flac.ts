// A FLAC frame decoder for 16-bit audio, as CHD's "cdfl" codec stores CD audio: bare
// frames (no stream header), decoded until a known number of samples is reached.

class BitReader {
  private bitPosition: number;

  constructor(
    private readonly data: Uint8Array,
    start: number,
  ) {
    this.bitPosition = start * 8;
  }

  get bytePosition(): number {
    return Math.ceil(this.bitPosition / 8);
  }

  alignToByte(): void {
    this.bitPosition = Math.ceil(this.bitPosition / 8) * 8;
  }

  read(count: number): number {
    let value = 0;
    while (count > 0) {
      const byte = this.data[this.bitPosition >> 3] ?? 0;
      const available = 8 - (this.bitPosition & 7);
      const take = Math.min(available, count);
      const shift = available - take;
      value = value * (1 << take) + ((byte >> shift) & ((1 << take) - 1));
      this.bitPosition += take;
      count -= take;
    }
    return value;
  }

  readSigned(count: number): number {
    if (count === 0) return 0;
    const value = this.read(count);
    return value >= 2 ** (count - 1) ? value - 2 ** count : value;
  }

  /** Counts zero bits up to (and past) the next one bit. */
  unary(): number {
    let count = 0;
    for (;;) {
      const byte = this.data[this.bitPosition >> 3] ?? 0xff;
      const offset = this.bitPosition & 7;
      const rest = (byte << offset) & 0xff;
      if (rest === 0) {
        count += 8 - offset;
        this.bitPosition += 8 - offset;
        continue;
      }
      const zeros = Math.clz32(rest) - 24;
      count += zeros;
      this.bitPosition += zeros + 1;
      return count;
    }
  }

  /** The UTF-8-like coded frame or sample number. */
  skipCodedNumber(): void {
    const first = this.read(8);
    let extra = 0;
    for (let mask = 0x80; first & mask && mask; mask >>= 1) extra++;
    for (let i = 1; i < extra; i++) this.read(8);
  }
}

const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, -1, -2, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const SAMPLE_SIZES = [0, 8, 12, 0, 16, 20, 24, 0];

function decodeResidual(reader: BitReader, blockSize: number, order: number, out: Int32Array): void {
  const method = reader.read(2);
  const paramBits = method === 0 ? 4 : 5;
  const escape = method === 0 ? 15 : 31;
  const partitionOrder = reader.read(4);
  const partitions = 1 << partitionOrder;
  let index = order;
  for (let p = 0; p < partitions; p++) {
    const count = (blockSize >> partitionOrder) - (p === 0 ? order : 0);
    const param = reader.read(paramBits);
    if (param === escape) {
      const bits = reader.read(5);
      for (let i = 0; i < count; i++) out[index++] = reader.readSigned(bits);
      continue;
    }
    for (let i = 0; i < count; i++) {
      const value = reader.unary() * (1 << param) + (param ? reader.read(param) : 0);
      out[index++] = value & 1 ? -((value + 1) / 2) : value / 2;
    }
  }
}

const FIXED_COEFFICIENTS = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function decodeSubframe(reader: BitReader, blockSize: number, bitsPerSample: number, out: Int32Array): void {
  reader.read(1);
  const type = reader.read(6);
  let wasted = 0;
  if (reader.read(1)) wasted = reader.unary() + 1;
  const bps = bitsPerSample - wasted;
  if (type === 0) {
    out.fill(reader.readSigned(bps), 0, blockSize);
  } else if (type === 1) {
    for (let i = 0; i < blockSize; i++) out[i] = reader.readSigned(bps);
  } else if (type >= 8 && type <= 12) {
    const order = type - 8;
    for (let i = 0; i < order; i++) out[i] = reader.readSigned(bps);
    decodeResidual(reader, blockSize, order, out);
    const c = FIXED_COEFFICIENTS[order];
    for (let i = order; i < blockSize; i++) {
      let prediction = 0;
      for (let j = 0; j < order; j++) prediction += c[j] * out[i - 1 - j];
      out[i] += prediction;
    }
  } else if (type >= 32) {
    const order = type - 31;
    for (let i = 0; i < order; i++) out[i] = reader.readSigned(bps);
    const precision = reader.read(4) + 1;
    const shift = reader.readSigned(5);
    const coefficients = new Int32Array(order);
    for (let i = 0; i < order; i++) coefficients[i] = reader.readSigned(precision);
    decodeResidual(reader, blockSize, order, out);
    for (let i = order; i < blockSize; i++) {
      let sum = 0;
      for (let j = 0; j < order; j++) sum += coefficients[j] * out[i - 1 - j];
      out[i] += Math.floor(sum / 2 ** shift);
    }
  } else {
    throw new Error('Damaged FLAC data (bad subframe type).');
  }
  if (wasted) for (let i = 0; i < blockSize; i++) out[i] *= 1 << wasted;
}

/**
 * Decodes FLAC frames from `start` until `samples` stereo samples are written to `out`
 * (interleaved left, right). Returns the byte position after the last frame.
 */
export function decodeFlac(input: Uint8Array, start: number, out: Int16Array, samples: number): number {
  const reader = new BitReader(input, start);
  const left = new Int32Array(65536);
  const right = new Int32Array(65536);
  let written = 0;
  while (written < samples) {
    const sync = reader.read(15);
    if (sync !== 0x7ffc) throw new Error('Damaged FLAC data (lost frame sync).');
    reader.read(1);
    const blockCode = reader.read(4);
    const rateCode = reader.read(4);
    const channelCode = reader.read(4);
    const sizeCode = reader.read(3);
    reader.read(1);
    reader.skipCodedNumber();
    let blockSize = BLOCK_SIZES[blockCode];
    if (blockSize === -1) blockSize = reader.read(8) + 1;
    else if (blockSize === -2) blockSize = reader.read(16) + 1;
    if (rateCode === 12) reader.read(8);
    else if (rateCode === 13 || rateCode === 14) reader.read(16);
    reader.read(8); // CRC-8
    const bps = SAMPLE_SIZES[sizeCode] || 16;
    if (channelCode === 0) {
      decodeSubframe(reader, blockSize, bps, left);
      right.set(left.subarray(0, blockSize));
    } else if (channelCode < 8) {
      decodeSubframe(reader, blockSize, bps, left);
      decodeSubframe(reader, blockSize, bps, right);
    } else {
      decodeSubframe(reader, blockSize, bps + (channelCode === 9 ? 1 : 0), left);
      decodeSubframe(reader, blockSize, bps + (channelCode === 9 ? 0 : 1), right);
      for (let i = 0; i < blockSize; i++) {
        const a = left[i];
        const b = right[i];
        if (channelCode === 8) right[i] = a - b;
        else if (channelCode === 9) left[i] = a + b;
        else {
          const mid = a * 2 + (b & 1);
          left[i] = (mid + b) >> 1;
          right[i] = (mid - b) >> 1;
        }
      }
    }
    reader.alignToByte();
    reader.read(16); // CRC-16
    for (let i = 0; i < blockSize && written < samples; i++, written++) {
      out[written * 2] = left[i];
      out[written * 2 + 1] = right[i];
    }
  }
  return reader.bytePosition;
}
