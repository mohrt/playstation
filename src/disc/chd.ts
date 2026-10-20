// CHD (MAME's compressed hunks of data), version 5, as made by `chdman createcd`: the
// disc's frames (2352 bytes of sector and 96 of subcode) in compressed hunks.
import type { ByteSource } from './disc';
import { decodeFlac } from './flac';
import { inflateRaw } from './inflate';
import { decodeLzma } from './lzma';

// CD error correction (the P and Q codes over GF(2^8)), for sectors whose ECC chdman left out.
const ECC_F = new Uint8Array(256);
const ECC_B = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const j = ((i << 1) ^ (i & 0x80 ? 0x11d : 0)) & 0xff;
  ECC_F[i] = j;
  ECC_B[i ^ j] = i;
}

function eccCompute(sector: Uint8Array, majorCount: number, minorCount: number, majorMult: number, minorInc: number, dest: number): void {
  const size = majorCount * minorCount;
  for (let major = 0; major < majorCount; major++) {
    let index = (major >> 1) * majorMult + (major & 1);
    let a = 0;
    let b = 0;
    for (let minor = 0; minor < minorCount; minor++) {
      const value = sector[12 + index];
      index += minorInc;
      if (index >= size) index -= size;
      a ^= value;
      b ^= value;
      a = ECC_F[a];
    }
    a = ECC_B[ECC_F[a] ^ b];
    sector[dest + major] = a;
    sector[dest + major + majorCount] = a ^ b;
  }
}

/** Rebuilds a sector's ECC; mode 2 sectors compute it with their header as zeros. */
function eccGenerate(sector: Uint8Array): void {
  const header = sector.slice(12, 16);
  if (sector[15] === 2) sector.fill(0, 12, 16);
  eccCompute(sector, 86, 24, 2, 86, 0x81c);
  eccCompute(sector, 52, 43, 86, 88, 0x8c8);
  sector.set(header, 12);
}

const FRAME_SIZE = 2448;
const SECTOR_DATA = 2352;
const SYNC = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

// Hunk map entry types.
const COMPRESSION_NONE = 4;
const COMPRESSION_SELF = 5;
const COMPRESSION_PARENT = 6;
const COMPRESSION_RLE_SMALL = 7;
const COMPRESSION_RLE_LARGE = 8;
const COMPRESSION_SELF_0 = 9;
const COMPRESSION_SELF_1 = 10;
const COMPRESSION_PARENT_SELF = 11;
const COMPRESSION_PARENT_0 = 12;
const COMPRESSION_PARENT_1 = 13;

/** Bytes of sector data each track type stores per frame. */
const TRACK_DATA_SIZE: Record<string, number> = {
  MODE1: 2048,
  'MODE1/2048': 2048,
  MODE1_RAW: 2352,
  'MODE1/2352': 2352,
  MODE2: 2336,
  'MODE2/2336': 2336,
  MODE2_FORM1: 2048,
  'MODE2/2048': 2048,
  MODE2_FORM2: 2324,
  'MODE2/2324': 2324,
  MODE2_FORM_MIX: 2336,
  MODE2_RAW: 2352,
  'MODE2/2352': 2352,
  AUDIO: 2352,
};

export interface ChdTrack {
  number: number;
  type: string;
  audio: boolean;
  /** Frames stored, pregap included when it is in the file. */
  frames: number;
  pregap: number;
  pregapInFile: boolean;
  /** The track's first frame in the CHD (tracks are padded to multiples of 4 frames). */
  firstFrame: number;
  /** Sector data bytes per frame (2352 for raw tracks). */
  dataSize: number;
}

/** MSB-first bit reader over a byte array (bits past the end read as zero). */
class BitStream {
  private bit = 0;

  constructor(private readonly data: Uint8Array) {}

  peek(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const bit = this.bit + i;
      const byte = this.data[bit >> 3] ?? 0;
      value = value * 2 + ((byte >> (7 - (bit & 7))) & 1);
    }
    return value;
  }

  read(count: number): number {
    const value = this.peek(count);
    this.bit += count;
    return value;
  }
}

/** The canonical Huffman decoder MAME uses for the hunk map (16 codes, up to 8 bits). */
class MapHuffman {
  private readonly lookup = new Uint16Array(256);

  constructor(bits: BitStream) {
    const lengths = new Uint8Array(16);
    for (let code = 0; code < 16; ) {
      let length = bits.read(4);
      if (length !== 1) lengths[code++] = length;
      else {
        length = bits.read(4);
        if (length === 1) lengths[code++] = 1;
        else {
          const repeat = bits.read(4) + 3;
          for (let i = 0; i < repeat && code < 16; i++) lengths[code++] = length;
        }
      }
    }
    // Canonical codes: start values per length, longest first.
    const histogram = new Uint32Array(33);
    for (const length of lengths) histogram[length]++;
    let start = 0;
    for (let length = 32; length > 0; length--) {
      const next = (start + histogram[length]) >> 1;
      histogram[length] = start;
      start = next;
    }
    for (let code = 0; code < 16; code++) {
      const length = lengths[code];
      if (!length) continue;
      const bitsValue = histogram[length]++;
      const shift = 8 - length;
      for (let i = bitsValue << shift; i < (bitsValue + 1) << shift; i++) this.lookup[i] = (code << 5) | length;
    }
  }

  decode(bits: BitStream): number {
    const entry = this.lookup[bits.peek(8)];
    bits.read(entry & 0x1f);
    return entry >> 5;
  }
}

export class ChdFile {
  readonly hunkBytes: number;
  readonly tracks: ChdTrack[] = [];
  private readonly hunkCount: number;
  private readonly codecs: string[];
  private readonly mapType: Uint8Array;
  private readonly mapOffset: Float64Array;
  private readonly mapLength: Uint32Array;
  private readonly cache = new Map<number, Uint8Array>();
  private readonly baseBuffer: Uint8Array;
  private readonly flacSamples: Int16Array;

  constructor(private readonly source: ByteSource) {
    const header = source.read(0, 124);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const tag = String.fromCharCode(...header.subarray(0, 8));
    if (tag !== 'MComprHD') throw new Error('That file is not a CHD image.');
    const version = view.getUint32(12);
    if (version !== 5) throw new Error(`That CHD is version ${version}; only version 5 (chdman from 2012 on) is supported.`);
    this.codecs = [0, 1, 2, 3].map((i) => String.fromCharCode(...header.subarray(16 + i * 4, 20 + i * 4)).replace(/\0/g, ''));
    const logicalBytes = Number(view.getBigUint64(32));
    const mapOffset = Number(view.getBigUint64(40));
    const metaOffset = Number(view.getBigUint64(48));
    this.hunkBytes = view.getUint32(56);
    const unitBytes = view.getUint32(60);
    if (unitBytes !== FRAME_SIZE) throw new Error('That CHD is not a CD image (made with chdman createcd).');
    if (!header.subarray(104, 124).every((byte) => byte === 0)) throw new Error('That CHD needs a parent CHD, which is not supported.');
    this.hunkCount = Math.ceil(logicalBytes / this.hunkBytes);
    this.mapType = new Uint8Array(this.hunkCount);
    this.mapOffset = new Float64Array(this.hunkCount);
    this.mapLength = new Uint32Array(this.hunkCount);
    this.readMap(mapOffset);
    this.readTracks(metaOffset);
    const frames = this.hunkBytes / FRAME_SIZE;
    this.baseBuffer = new Uint8Array(frames * SECTOR_DATA);
    this.flacSamples = new Int16Array((frames * SECTOR_DATA) / 2);
  }

  private readMap(offset: number): void {
    const head = this.source.read(offset, 16);
    const view = new DataView(head.buffer, head.byteOffset, 16);
    const mapBytes = view.getUint32(0);
    const firstOffset = view.getUint16(4) * 2 ** 32 + view.getUint32(6);
    const lengthBits = head[12];
    const selfBits = head[13];
    const parentBits = head[14];
    const data = this.source.read(offset + 16, mapBytes).slice();
    const bits = new BitStream(data);
    // First each hunk's compression type, Huffman coded with runs; then the offsets and lengths.
    const huffman = new MapHuffman(bits);
    let last = 0;
    let repeat = 0;
    for (let hunk = 0; hunk < this.hunkCount; hunk++) {
      if (repeat > 0) {
        this.mapType[hunk] = last;
        repeat--;
        continue;
      }
      const value = huffman.decode(bits);
      if (value === COMPRESSION_RLE_SMALL) {
        this.mapType[hunk] = last;
        repeat = 2 + huffman.decode(bits);
      } else if (value === COMPRESSION_RLE_LARGE) {
        this.mapType[hunk] = last;
        repeat = 2 + 16 + (huffman.decode(bits) << 4);
        repeat += huffman.decode(bits);
      } else {
        this.mapType[hunk] = last = value;
      }
    }
    let current = firstOffset;
    let lastSelf = 0;
    let lastParent = 0;
    for (let hunk = 0; hunk < this.hunkCount; hunk++) {
      let type = this.mapType[hunk];
      let offset = current;
      let length = 0;
      switch (type) {
        case 0:
        case 1:
        case 2:
        case 3:
          length = bits.read(lengthBits);
          current += length;
          bits.read(16);
          break;
        case COMPRESSION_NONE:
          length = this.hunkBytes;
          current += length;
          bits.read(16);
          break;
        case COMPRESSION_SELF:
          lastSelf = offset = bits.read(selfBits);
          break;
        case COMPRESSION_PARENT:
          lastParent = offset = bits.read(parentBits);
          break;
        case COMPRESSION_SELF_1:
          lastSelf++;
          type = COMPRESSION_SELF;
          offset = lastSelf;
          break;
        case COMPRESSION_SELF_0:
          type = COMPRESSION_SELF;
          offset = lastSelf;
          break;
        case COMPRESSION_PARENT_SELF:
          type = COMPRESSION_PARENT;
          lastParent = offset = (hunk * this.hunkBytes) / FRAME_SIZE;
          break;
        case COMPRESSION_PARENT_1:
          lastParent += this.hunkBytes / FRAME_SIZE;
          type = COMPRESSION_PARENT;
          offset = lastParent;
          break;
        case COMPRESSION_PARENT_0:
          type = COMPRESSION_PARENT;
          offset = lastParent;
          break;
      }
      this.mapType[hunk] = type;
      this.mapOffset[hunk] = offset;
      this.mapLength[hunk] = length;
    }
  }

  private readTracks(offset: number): void {
    let frame = 0;
    for (let guard = 0; offset !== 0 && guard < 1000; guard++) {
      const head = this.source.read(offset, 16);
      const view = new DataView(head.buffer, head.byteOffset, 16);
      const tag = String.fromCharCode(...head.subarray(0, 4));
      const length = view.getUint32(4) & 0xffffff;
      const next = Number(view.getBigUint64(8));
      if (tag === 'CHT2' || tag === 'CHTR') {
        const text = new TextDecoder().decode(this.source.read(offset + 16, length)).replace(/\0.*$/, '');
        const field = (name: string) => new RegExp(`${name}:(\\S+)`).exec(text)?.[1] ?? '';
        const type = field('TYPE');
        const frames = Number(field('FRAMES'));
        const pregap = Number(field('PREGAP') || 0);
        const pregapType = field('PGTYPE');
        this.tracks.push({
          number: Number(field('TRACK')),
          type,
          audio: type === 'AUDIO',
          frames,
          pregap,
          pregapInFile: pregapType.startsWith('V'),
          firstFrame: frame,
          dataSize: TRACK_DATA_SIZE[type] ?? SECTOR_DATA,
        });
        frame += (frames + 3) & ~3;
      }
      offset = next;
    }
    if (this.tracks.length === 0) throw new Error('That CHD has no CD track list.');
    this.tracks.sort((a, b) => a.number - b.number);
  }

  /** A decompressed hunk (cached; the last few stay). */
  hunk(index: number): Uint8Array {
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached;
    }
    const out = new Uint8Array(this.hunkBytes);
    const type = this.mapType[index];
    const offset = this.mapOffset[index];
    if (type === COMPRESSION_NONE) out.set(this.source.read(offset, this.hunkBytes));
    else if (type === COMPRESSION_SELF) out.set(this.hunk(offset));
    else if (type === COMPRESSION_PARENT) throw new Error('That CHD needs a parent CHD, which is not supported.');
    else this.decompress(this.codecs[type], this.source.read(offset, this.mapLength[index]), out);
    this.cache.set(index, out);
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }

  private decompress(codec: string, data: Uint8Array, out: Uint8Array): void {
    const frames = this.hunkBytes / FRAME_SIZE;
    const base = this.baseBuffer;
    let eccFlags: Uint8Array | null = null;
    if (codec === 'cdzl' || codec === 'cdlz') {
      const lengthBytes = this.hunkBytes < 65536 ? 2 : 3;
      const eccBytes = (frames + 7) >> 3;
      let baseLength = (data[eccBytes] << 8) | data[eccBytes + 1];
      if (lengthBytes > 2) baseLength = (baseLength << 8) | data[eccBytes + 2];
      const start = eccBytes + lengthBytes;
      eccFlags = data.subarray(0, eccBytes);
      if (codec === 'cdzl') inflateRaw(data.subarray(start, start + baseLength), base);
      else decodeLzma(data.subarray(start, start + baseLength), 0, base);
    } else if (codec === 'cdfl') {
      // FLAC of the sectors as 16-bit stereo samples; CHD keeps them big-endian.
      const samples = (frames * SECTOR_DATA) / 4;
      decodeFlac(data, 0, this.flacSamples, samples);
      const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
      for (let i = 0; i < samples * 2; i++) view.setInt16(i * 2, this.flacSamples[i], false);
    } else if (codec === 'cdzs') {
      throw new Error('That CHD uses Zstandard compression, which is not supported yet: recompress it with chdman createcd -c cdlz,cdzl,cdfl.');
    } else {
      throw new Error(`That CHD uses the ${codec} codec, which is not supported.`);
    }
    for (let frame = 0; frame < frames; frame++) {
      const sector = out.subarray(frame * FRAME_SIZE, frame * FRAME_SIZE + SECTOR_DATA);
      sector.set(base.subarray(frame * SECTOR_DATA, (frame + 1) * SECTOR_DATA));
      if (eccFlags && eccFlags[frame >> 3] & (1 << (frame & 7))) {
        sector.set(SYNC);
        eccGenerate(sector);
      }
    }
  }

  /** The sector data of a frame (2352 bytes, or the track's data size), raw as the CHD stores it. */
  frame(index: number): Uint8Array {
    const perHunk = this.hunkBytes / FRAME_SIZE;
    const hunk = this.hunk(Math.floor(index / perHunk));
    const at = (index % perHunk) * FRAME_SIZE;
    return hunk.subarray(at, at + SECTOR_DATA);
  }
}

/** One CHD track's sectors as a byte source of 2352-byte (or data-size) sectors, audio in BIN byte order. */
export class ChdTrackSource implements ByteSource {
  readonly size: number;

  constructor(
    private readonly chd: ChdFile,
    private readonly track: ChdTrack,
  ) {
    this.size = track.frames * track.dataSize;
  }

  read(offset: number, length: number): Uint8Array {
    const size = this.track.dataSize;
    const out = new Uint8Array(length);
    for (let done = 0; done < length; ) {
      const index = Math.floor((offset + done) / size);
      const within = (offset + done) % size;
      const frame = this.chd.frame(this.track.firstFrame + index).subarray(0, size);
      const take = Math.min(size - within, length - done);
      out.set(frame.subarray(within, within + take), done);
      done += take;
    }
    // CHD stores CD audio big-endian; BIN images (and the CD-ROM) are little-endian.
    if (this.track.audio) {
      for (let i = 0; i + 1 < length; i += 2) {
        const byte = out[i];
        out[i] = out[i + 1];
        out[i + 1] = byte;
      }
    }
    return out;
  }
}
