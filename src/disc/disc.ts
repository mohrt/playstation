/** A raw CD sector: 12 sync bytes, a 4-byte header, then 2336 bytes (subheader and data for mode 2). */
export const SECTOR_SIZE = 2352;
/** Disc positions count from 00:02:00; the 2-second lead-in before it holds no data. */
export const LEAD_IN = 150;

/** Bytes of a disc image file, read on demand (synchronously, from a worker or Node). */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
}

export class MemorySource implements ByteSource {
  constructor(private readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.length;
  }

  read(offset: number, length: number): Uint8Array {
    return this.bytes.subarray(offset, offset + length);
  }
}

/** Reads a File (or Blob) in chunks with FileReaderSync, which only exists in workers. */
export class BlobSource implements ByteSource {
  private static readonly CHUNK = SECTOR_SIZE * 32;
  private readonly cache = new Map<number, Uint8Array>();

  constructor(private readonly blob: Blob) {}

  get size(): number {
    return this.blob.size;
  }

  read(offset: number, length: number): Uint8Array {
    const chunk = Math.floor(offset / BlobSource.CHUNK);
    const end = offset + length;
    if (end <= (chunk + 1) * BlobSource.CHUNK) {
      const data = this.chunk(chunk);
      const start = offset - chunk * BlobSource.CHUNK;
      return data.subarray(start, start + length);
    }
    const out = new Uint8Array(length);
    for (let at = offset; at < end; ) {
      const index = Math.floor(at / BlobSource.CHUNK);
      const data = this.chunk(index);
      const start = at - index * BlobSource.CHUNK;
      const take = Math.min(end - at, data.length - start);
      if (take <= 0) break;
      out.set(data.subarray(start, start + take), at - offset);
      at += take;
    }
    return out;
  }

  private chunk(index: number): Uint8Array {
    let data = this.cache.get(index);
    if (data) {
      // Most recently used chunks stay at the end of the map.
      this.cache.delete(index);
      this.cache.set(index, data);
      return data;
    }
    const start = index * BlobSource.CHUNK;
    const reader = new FileReaderSync();
    data = new Uint8Array(reader.readAsArrayBuffer(this.blob.slice(start, start + BlobSource.CHUNK)));
    this.cache.set(index, data);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return data;
  }
}

declare class FileReaderSync {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

export interface Track {
  number: number;
  audio: boolean;
  /** Disc LBA (0 = 00:02:00) where index 1 starts. */
  start: number;
  /** Sectors from index 1 to the track's end. */
  length: number;
}

/** A run of disc sectors stored in one file (or not stored at all: silence and pregaps). */
interface Extent {
  start: number;
  end: number;
  source: ByteSource | null;
  offset: number;
  /** 2352 for raw images, 2048 for ISO images (sectors without headers). */
  sectorSize: number;
  track: Track;
}

const toBcd = (value: number) => ((Math.floor(value / 10) % 10) << 4) | (value % 10);

/** Minutes, seconds and frames (75 per second) of an absolute sector number. */
export function msf(sector: number): [number, number, number] {
  return [Math.floor(sector / 4500), Math.floor(sector / 75) % 60, sector % 75];
}

export function bcd(value: number): number {
  return toBcd(value);
}

export function fromBcd(value: number): number {
  return (value >> 4) * 10 + (value & 0xf);
}

/** A disc image: its tracks and a way to read any sector raw. */
export class Disc {
  readonly tracks: Track[] = [];
  private readonly extents: Extent[] = [];
  /** The LBA after the last sector (the lead-out). */
  leadOut = 0;

  private constructor() {}

  /** A disc from a CUE sheet, with the files it names. */
  static fromCue(cue: string, files: Map<string, ByteSource>): Disc {
    const disc = new Disc();
    const lines = cue.split(/\r?\n/);
    interface CueTrack {
      number: number;
      audio: boolean;
      sectorSize: number;
      pregap: number;
      index0: number | null;
      index1: number | null;
    }
    const filesInOrder: { source: ByteSource; tracks: CueTrack[] }[] = [];
    let currentFile: { source: ByteSource; tracks: CueTrack[] } | null = null;
    const parseMsf = (text: string) => {
      const [m, s, f] = text.split(':').map(Number);
      return (m * 60 + s) * 75 + f;
    };
    for (const raw of lines) {
      const line = raw.trim();
      const fileMatch = /^FILE\s+(?:"([^"]+)"|(\S+))/i.exec(line);
      if (fileMatch) {
        const name = fileMatch[1] ?? fileMatch[2];
        const source = findFile(files, name);
        if (!source) throw new Error(`The CUE sheet needs "${name}" too: drop it together with the .cue file.`);
        currentFile = { source, tracks: [] };
        filesInOrder.push(currentFile);
        continue;
      }
      const trackMatch = /^TRACK\s+(\d+)\s+(\S+)/i.exec(line);
      if (trackMatch && currentFile) {
        const type = trackMatch[2].toUpperCase();
        const sectorSize = type === 'MODE1/2048' || type === 'MODE2/2048' ? 2048 : type === 'MODE2/2336' ? 2336 : SECTOR_SIZE;
        currentFile.tracks.push({ number: Number(trackMatch[1]), audio: type === 'AUDIO', sectorSize, pregap: 0, index0: null, index1: null });
        continue;
      }
      const track = currentFile?.tracks[currentFile.tracks.length - 1];
      const indexMatch = /^INDEX\s+(\d+)\s+(\d+:\d+:\d+)/i.exec(line);
      if (indexMatch && track) {
        const index = Number(indexMatch[1]);
        if (index === 0) track.index0 = parseMsf(indexMatch[2]);
        if (index === 1) track.index1 = parseMsf(indexMatch[2]);
        continue;
      }
      const pregapMatch = /^PREGAP\s+(\d+:\d+:\d+)/i.exec(line);
      if (pregapMatch && track) track.pregap = parseMsf(pregapMatch[1]);
    }
    if (filesInOrder.length === 0) throw new Error('That CUE sheet names no files.');

    let lba = 0;
    for (const file of filesInOrder) {
      const sectorSize = file.tracks[0]?.sectorSize ?? SECTOR_SIZE;
      const fileSectors = Math.floor(file.source.size / sectorSize);
      let inserted = 0;
      file.tracks.forEach((cueTrack, i) => {
        const index1 = cueTrack.index1 ?? cueTrack.index0 ?? 0;
        const next = file.tracks[i + 1];
        const fileEnd = next ? (next.index0 ?? next.index1 ?? fileSectors) : fileSectors;
        const fileStart = cueTrack.index0 ?? index1;
        if (cueTrack.pregap > 0) {
          // A PREGAP is silence that isn't in the file.
          const track = { number: cueTrack.number, audio: cueTrack.audio, start: 0, length: 0 };
          disc.extents.push({ start: lba + fileStart + inserted, end: lba + fileStart + inserted + cueTrack.pregap, source: null, offset: 0, sectorSize, track });
          inserted += cueTrack.pregap;
        }
        const track: Track = { number: cueTrack.number, audio: cueTrack.audio, start: lba + index1 + inserted, length: fileEnd - index1 };
        disc.tracks.push(track);
        disc.extents.push({ start: lba + fileStart + inserted, end: lba + fileEnd + inserted, source: file.source, offset: fileStart * sectorSize, sectorSize, track });
        for (const extent of disc.extents) if (extent.track.number === cueTrack.number && extent.source === null) extent.track = track;
      });
      lba += fileSectors + inserted;
    }
    disc.leadOut = lba;
    disc.extents.sort((a, b) => a.start - b.start);
    return disc;
  }

  /** A single-track disc from a raw .bin (2352-byte sectors) or an .iso (2048-byte sectors). */
  static fromImage(source: ByteSource): Disc {
    const disc = new Disc();
    const raw = looksRaw(source);
    const sectorSize = raw ? SECTOR_SIZE : 2048;
    const sectors = Math.floor(source.size / sectorSize);
    const track: Track = { number: 1, audio: false, start: 0, length: sectors };
    disc.tracks.push(track);
    disc.extents.push({ start: 0, end: sectors, source, offset: 0, sectorSize, track });
    disc.leadOut = sectors;
    return disc;
  }

  private extentAt(lba: number): Extent | null {
    for (const extent of this.extents) if (lba >= extent.start && lba < extent.end) return extent;
    return null;
  }

  /** The track a sector belongs to (pregaps belong to the track after them). */
  trackAt(lba: number): Track {
    const extent = this.extentAt(lba);
    if (extent) return extent.track;
    return lba >= this.leadOut ? this.tracks[this.tracks.length - 1] : this.tracks[0];
  }

  /** Reads a raw 2352-byte sector into `out`; returns false past the end of the disc. */
  readSector(lba: number, out: Uint8Array): boolean {
    const extent = this.extentAt(lba);
    if (!extent) {
      out.fill(0);
      return lba >= 0 && lba < this.leadOut;
    }
    if (!extent.source) {
      out.fill(0);
      if (!extent.track.audio) writeHeader(out, lba);
      return true;
    }
    const position = extent.offset + (lba - extent.start) * extent.sectorSize;
    if (extent.sectorSize === SECTOR_SIZE) {
      out.set(extent.source.read(position, SECTOR_SIZE));
      return true;
    }
    // Sectors stored without their header: rebuild one as mode 2 form 1.
    out.fill(0);
    writeHeader(out, lba);
    if (extent.sectorSize === 2048) {
      out[18] = out[22] = 0x08;
      out.set(extent.source.read(position, 2048), 24);
    } else {
      out.set(extent.source.read(position, 2336), 16);
    }
    return true;
  }
}

function findFile(files: Map<string, ByteSource>, name: string): ByteSource | undefined {
  const base = name.split(/[\\/]/).pop()!.toLowerCase();
  for (const [fileName, source] of files) if (fileName.toLowerCase() === base) return source;
  return undefined;
}

/** Raw images start with the 12-byte sync pattern 00 FF×10 00. */
function looksRaw(source: ByteSource): boolean {
  if (source.size % SECTOR_SIZE === 0 && source.size % 2048 !== 0) return true;
  const head = source.read(0, 12);
  if (head[0] !== 0 || head[11] !== 0) return false;
  for (let i = 1; i < 11; i++) if (head[i] !== 0xff) return false;
  return true;
}

function writeHeader(out: Uint8Array, lba: number): void {
  out[0] = 0;
  out.fill(0xff, 1, 11);
  out[11] = 0;
  const [m, s, f] = msf(lba + LEAD_IN);
  out[12] = toBcd(m);
  out[13] = toBcd(s);
  out[14] = toBcd(f);
  out[15] = 2;
}

// --- ISO 9660: finding SYSTEM.CNF, for the game's ID and region --------------------

export type DiscRegion = 'ntsc-u' | 'ntsc-j' | 'pal';

export interface DiscInfo {
  /** The boot executable's name, such as SLUS_005.94, or null for discs without SYSTEM.CNF. */
  bootFile: string | null;
  /** The game's serial, such as SLUS-00594. */
  serial: string | null;
  region: DiscRegion;
}

function readData(disc: Disc, lba: number): Uint8Array {
  const sector = new Uint8Array(SECTOR_SIZE);
  disc.readSector(lba, sector);
  return sector.subarray(24, 24 + 2048);
}

/** Finds a file in the root directory: [LBA, size]. */
function findRootFile(disc: Disc, wanted: string): [number, number] | null {
  const pvd = readData(disc, 16);
  if (String.fromCharCode(...pvd.subarray(1, 6)) !== 'CD001') return null;
  const view = new DataView(pvd.buffer, pvd.byteOffset);
  const rootLba = view.getUint32(156 + 2, true);
  const rootSize = view.getUint32(156 + 10, true);
  for (let sector = 0; sector * 2048 < rootSize && sector < 32; sector++) {
    const data = readData(disc, rootLba + sector);
    const dir = new DataView(data.buffer, data.byteOffset);
    for (let offset = 0; offset < 2048; ) {
      const length = data[offset];
      if (length === 0) break;
      const nameLength = data[offset + 32];
      const name = String.fromCharCode(...data.subarray(offset + 33, offset + 33 + nameLength)).split(';')[0].toUpperCase();
      if (name === wanted) return [dir.getUint32(offset + 2, true), dir.getUint32(offset + 10, true)];
      offset += length;
    }
  }
  return null;
}

export function discInfo(disc: Disc): DiscInfo {
  let bootFile: string | null = null;
  try {
    const found = findRootFile(disc, 'SYSTEM.CNF');
    if (found) {
      const text = new TextDecoder().decode(readData(disc, found[0]).subarray(0, Math.min(found[1], 2048)));
      const boot = /BOOT\s*=\s*cdrom:\\?([^;\s]+)/i.exec(text);
      if (boot) bootFile = boot[1].split('\\').pop()!.toUpperCase();
    }
  } catch {
    // Not an ISO 9660 disc (an audio CD, or damaged).
  }
  const serialMatch = bootFile ? /^([A-Z]{4})[_-](\d{3})\.?(\d{2})/.exec(bootFile) : null;
  const serial = serialMatch ? `${serialMatch[1]}-${serialMatch[2]}${serialMatch[3]}` : null;
  const prefix = serialMatch?.[1] ?? '';
  let region: DiscRegion = 'ntsc-u';
  if (/^S[CL]E[S]|^SCED|^SLED|^SCES|^SLES/.test(prefix)) region = 'pal';
  else if (/^S[CL]P[SMB]|^SCAJ|^SLKA|^SCPM|^SIPS|^SCZS/.test(prefix)) region = 'ntsc-j';
  else {
    // Without a serial, the licence text in sector 4 tells the region.
    const licence = String.fromCharCode(...readData(disc, 4).subarray(0, 80));
    if (/Europe/i.test(licence)) region = 'pal';
    else if (/Inc\./.test(licence) && !/Amer/i.test(licence)) region = 'ntsc-j';
  }
  return { bootFile, serial, region };
}
