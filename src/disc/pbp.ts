// PBP (the PSP's EBOOT.PBP), as made by popstation and pop-fe: one or more PSISOIMG disc
// images in DATA.PSAR, each a TOC and the disc's raw sectors in deflated 16-sector blocks.
import { fromBcd, LEAD_IN, type ByteSource } from './disc';
import { inflateRaw } from './inflate';

const BLOCK_SIZE = 16 * 2352;
const INDEX_OFFSET = 0x4000;
const DATA_OFFSET = 0x100000;
const MAX_DISCS = 5;

export interface PbpTrack {
  number: number;
  audio: boolean;
  /** Disc LBA where index 1 starts. */
  start: number;
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const u32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);

/** The discs in a PBP file. */
export class PbpFile {
  /** Where each disc's PSISOIMG starts in the file. */
  readonly discOffsets: number[] = [];

  constructor(private readonly source: ByteSource) {
    const header = source.read(0, 0x28);
    if (source.size < 0x28 || ascii(header.subarray(0, 4)) !== '\0PBP') throw new Error("That file isn't a PBP (EBOOT.PBP) image.");
    const psar = u32(header, 0x24);
    const tag = ascii(source.read(psar, 16));
    if (tag.startsWith('PSISOIMG0000')) {
      this.discOffsets.push(psar);
    } else if (tag === 'PSTITLEIMG000000') {
      const offsets = source.read(psar + 0x200, MAX_DISCS * 4);
      for (let i = 0; i < MAX_DISCS; i++) {
        const offset = u32(offsets, i * 4);
        if (offset === 0) break;
        this.discOffsets.push(psar + offset);
      }
    }
    if (this.discOffsets.length === 0) {
      throw new Error("That PBP has no PlayStation disc in it, or it's encrypted (as PlayStation Store downloads are): convert it to CUE/BIN first.");
    }
  }

  get discCount(): number {
    return this.discOffsets.length;
  }

  /** The game's title from PARAM.SFO, if it has one. */
  get title(): string | null {
    const header = this.source.read(0, 0x28);
    const start = u32(header, 0x08);
    const sfo = this.source.read(start, u32(header, 0x0c) - start);
    if (sfo.length < 0x14 || ascii(sfo.subarray(0, 4)) !== '\0PSF') return null;
    const keys = u32(sfo, 0x08);
    const values = u32(sfo, 0x0c);
    for (let i = 0; i < u32(sfo, 0x10) && 0x14 + i * 16 + 16 <= sfo.length; i++) {
      const entry = 0x14 + i * 16;
      const keyStart = keys + (sfo[entry] | (sfo[entry + 1] << 8));
      const keyEnd = sfo.indexOf(0, keyStart);
      if (ascii(sfo.subarray(keyStart, keyEnd)) !== 'TITLE') continue;
      const value = sfo.subarray(values + u32(sfo, entry + 12), values + u32(sfo, entry + 12) + u32(sfo, entry + 4));
      const title = new TextDecoder().decode(value).replace(/\0.*$/s, '').trim();
      return title || null;
    }
    return null;
  }

  disc(index: number): PbpImage {
    return new PbpImage(this.source, this.discOffsets[index]);
  }
}

/** One disc of a PBP, read as a flat raw image (the BIN it was made from) with its TOC. */
export class PbpImage implements ByteSource {
  readonly size: number;
  readonly tracks: PbpTrack[] = [];
  /** The LBA after the last sector, from the TOC (or the image's size). */
  readonly leadOut: number;
  private readonly blockOffsets: number[] = [];
  private readonly blockLengths: number[] = [];
  private readonly cache = new Map<number, Uint8Array>();

  constructor(
    private readonly source: ByteSource,
    private readonly base: number,
  ) {
    if (ascii(source.read(base, 12)) !== 'PSISOIMG0000') throw new Error('That PBP is damaged: a disc image is missing.');
    // The index runs until an entry of length 0 (the size field before it may hold the compressed size instead).
    const index = source.read(base + INDEX_OFFSET, DATA_OFFSET - INDEX_OFFSET);
    for (let i = 0; i * 32 < index.length; i++) {
      const length = index[i * 32 + 4] | (index[i * 32 + 5] << 8);
      if (length === 0) break;
      this.blockOffsets.push(u32(index, i * 32));
      this.blockLengths.push(length);
    }
    if (this.blockOffsets.length === 0 || this.blockOffsets[0] !== 0 || this.blockLengths[0] > BLOCK_SIZE) {
      throw new Error("That PBP's disc image is encrypted (as PlayStation Store downloads are): convert it to CUE/BIN first.");
    }
    this.size = this.blockOffsets.length * BLOCK_SIZE;
    this.leadOut = this.readToc(source.read(base + 0x800, 1020)) ?? this.size / 2352;
    if (this.tracks.length === 0) this.tracks.push({ number: 1, audio: false, start: 0 });
  }

  /** The disc's ID as the PSP shows it, such as SLUS00594. */
  get discId(): string {
    return ascii(this.source.read(this.base + 0x400, 11)).replace(/[_\0]/g, '');
  }

  /** Reads the TOC's Q-subchannel entries (10 bytes each); returns the lead-out's LBA. */
  private readToc(toc: Uint8Array): number | null {
    let leadOut: number | null = null;
    for (let at = 0; at + 10 <= toc.length && toc[at + 2] !== 0; at += 10) {
      const point = toc[at + 2];
      const lba = (fromBcd(toc[at + 7]) * 60 + fromBcd(toc[at + 8])) * 75 + fromBcd(toc[at + 9]) - LEAD_IN;
      if (point === 0xa2) leadOut = lba;
      else if (point <= 0x99) this.tracks.push({ number: fromBcd(point), audio: (toc[at] & 0x40) === 0, start: lba });
    }
    this.tracks.sort((a, b) => a.start - b.start);
    return leadOut;
  }

  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let at = offset; at < offset + length; ) {
      const index = Math.floor(at / BLOCK_SIZE);
      const start = at - index * BLOCK_SIZE;
      const take = Math.min(offset + length - at, BLOCK_SIZE - start);
      // Past the stored blocks (a lead-out the image was cut short of) reads as zeros.
      if (index < this.blockOffsets.length) out.set(this.block(index).subarray(start, start + take), at - offset);
      at += take;
    }
    return out;
  }

  private block(index: number): Uint8Array {
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached;
    }
    const length = this.blockLengths[index];
    const stored = this.source.read(this.base + DATA_OFFSET + this.blockOffsets[index], length);
    let block: Uint8Array;
    if (length === BLOCK_SIZE) {
      block = stored.slice();
    } else {
      block = new Uint8Array(BLOCK_SIZE);
      inflateRaw(stored, block);
    }
    this.cache.set(index, block);
    if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
    return block;
  }
}
