// A synchronous raw DEFLATE (RFC 1951) decoder. The browser's DecompressionStream is
// asynchronous, but disc sectors are read synchronously in the worker.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code as a table indexed by `bits` reversed bits: entry = symbol << 4 | length. */
interface Huffman {
  table: Int32Array;
  bits: number;
}

function buildHuffman(lengths: ArrayLike<number>, count: number): Huffman {
  let maxBits = 0;
  for (let i = 0; i < count; i++) maxBits = Math.max(maxBits, lengths[i]);
  const bits = Math.max(1, maxBits);
  const table = new Int32Array(1 << bits).fill(-1);
  const histogram = new Int32Array(16);
  for (let i = 0; i < count; i++) histogram[lengths[i]]++;
  histogram[0] = 0;
  const next = new Int32Array(16);
  let code = 0;
  for (let length = 1; length <= 15; length++) {
    code = (code + histogram[length - 1]) << 1;
    next[length] = code;
  }
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[symbol];
    if (!length) continue;
    const c = next[length]++;
    // Huffman codes are stored most significant bit first; the stream is read least significant first.
    let reversed = 0;
    for (let i = 0; i < length; i++) reversed |= ((c >> i) & 1) << (length - 1 - i);
    for (let fill = reversed; fill < 1 << bits; fill += 1 << length) table[fill] = (symbol << 4) | length;
  }
  return { table, bits };
}

const FIXED_LITERALS = buildHuffman(Uint8Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)), 288);
const FIXED_DISTANCES = buildHuffman(new Uint8Array(30).fill(5), 30);

/**
 * Inflates raw DEFLATE data into `out` (whose length is the expected size);
 * returns the number of input bytes used.
 */
export function inflateRaw(input: Uint8Array, out: Uint8Array): number {
  let position = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let written = 0;

  const need = (n: number) => {
    while (bitCount < n) {
      bitBuffer |= (position < input.length ? input[position] : 0) << bitCount;
      position++;
      bitCount += 8;
    }
  };
  const bits = (n: number) => {
    if (n === 0) return 0;
    need(n);
    const value = bitBuffer & ((1 << n) - 1);
    bitBuffer >>>= n;
    bitCount -= n;
    return value;
  };
  const decode = (huffman: Huffman) => {
    need(huffman.bits);
    const entry = huffman.table[bitBuffer & ((1 << huffman.bits) - 1)];
    if (entry < 0) throw new Error('Damaged compressed data (bad Huffman code).');
    const length = entry & 15;
    bitBuffer >>>= length;
    bitCount -= length;
    return entry >> 4;
  };

  for (let last = 0; !last && written < out.length; ) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored blocks start on a byte boundary: drop the partial byte, give back whole ones read ahead.
      position -= bitCount >> 3;
      bitBuffer = bitCount = 0;
      const length = input[position] | (input[position + 1] << 8);
      position += 4;
      out.set(input.subarray(position, position + Math.min(length, out.length - written)), written);
      written += length;
      position += length;
      continue;
    }
    let literals = FIXED_LITERALS;
    let distances = FIXED_DISTANCES;
    if (type === 2) {
      const literalCount = bits(5) + 257;
      const distanceCount = bits(5) + 1;
      const codeLengthCount = bits(4) + 4;
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < codeLengthCount; i++) codeLengths[CODE_LENGTH_ORDER[i]] = bits(3);
      const codeLengthCode = buildHuffman(codeLengths, 19);
      const lengths = new Uint8Array(literalCount + distanceCount);
      for (let i = 0; i < lengths.length; ) {
        const symbol = decode(codeLengthCode);
        if (symbol < 16) lengths[i++] = symbol;
        else if (symbol === 16) {
          const repeat = 3 + bits(2);
          const previous = lengths[i - 1];
          for (let r = 0; r < repeat; r++) lengths[i++] = previous;
        } else {
          const repeat = symbol === 17 ? 3 + bits(3) : 11 + bits(7);
          i += repeat;
        }
      }
      literals = buildHuffman(lengths.subarray(0, literalCount), literalCount);
      distances = buildHuffman(lengths.subarray(literalCount), distanceCount);
    } else if (type === 3) {
      throw new Error('Damaged compressed data (bad block type).');
    }
    for (;;) {
      const symbol = decode(literals);
      if (symbol < 256) {
        out[written++] = symbol;
        continue;
      }
      if (symbol === 256) break;
      const index = symbol - 257;
      const length = LENGTH_BASE[index] + bits(LENGTH_EXTRA[index]);
      const distanceSymbol = decode(distances);
      const distance = DIST_BASE[distanceSymbol] + bits(DIST_EXTRA[distanceSymbol]);
      for (let i = 0; i < length; i++, written++) out[written] = out[written - distance];
    }
  }
  return position - (bitCount >> 3);
}
