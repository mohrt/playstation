import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ChdFile } from '../../src/disc/chd';
import { PbpFile } from '../../src/disc/pbp';
import { Disc, SECTOR_SIZE, type ByteSource } from '../../src/disc/disc';
import { discMedia, type LoadedMedia } from '../../src/media';
import { ROOT } from './machine';

/** A file read on demand, like the browser's BlobSource. */
export class FileSource implements ByteSource {
  readonly size: number;
  private readonly fd: number;

  constructor(path: string) {
    this.size = statSync(path).size;
    this.fd = openSync(path, 'r');
  }

  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, Math.min(length, this.size - offset)));
    readSync(this.fd, out, 0, out.length, offset);
    return out;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** A disc from a .cue (with its files next to it) or a single .bin/.iso. */
export function openDisc(path: string): LoadedMedia {
  if (path.toLowerCase().endsWith('.chd')) return discMedia(Disc.fromChd(new ChdFile(new FileSource(path))), basename(path));
  if (path.toLowerCase().endsWith('.pbp')) return discMedia(Disc.fromPbp(new PbpFile(new FileSource(path)).disc(0)), basename(path));
  if (path.toLowerCase().endsWith('.cue')) {
    const cue = readFileSync(path, 'utf8');
    const files = new Map<string, ByteSource>();
    for (const match of cue.matchAll(/FILE\s+"([^"]+)"/gi)) {
      const name = basename(match[1]);
      const file = join(dirname(path), name);
      if (existsSync(file)) files.set(name, new FileSource(file));
    }
    return discMedia(Disc.fromCue(cue, files), basename(path));
  }
  return discMedia(Disc.fromImage(new FileSource(path)), basename(path));
}

/** The discs in roms/ (your own; never committed): every .cue, .chd and .pbp, and .bin/.iso files without a .cue. */
export function romDiscs(): string[] {
  const dir = join(ROOT, 'roms');
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const cues = names.filter((name) => /\.cue$/i.test(name));
  const containers = names.filter((name) => /\.(chd|pbp)$/i.test(name));
  const covered = new Set(cues.flatMap((cue) => [...readFileSync(join(dir, cue), 'utf8').matchAll(/FILE\s+"([^"]+)"/gi)].map((m) => basename(m[1]).toLowerCase())));
  const images = names.filter((name) => /\.(bin|iso|img)$/i.test(name) && !covered.has(name.toLowerCase()));
  return [...cues, ...containers, ...images].map((name) => join(dir, name));
}

/** A small two-track disc: mode 2 data sectors with varied contents, then CD audio after a 2-second pregap. */
export function makeTestImage(seed = 1): { bin: Uint8Array; cue: string } {
  const dataSectors = 600;
  const audioSectors = 900;
  const bin = new Uint8Array((dataSectors + audioSectors) * SECTOR_SIZE);
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  for (let lba = 0; lba < dataSectors; lba++) {
    const sector = bin.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE);
    sector.set([0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0]);
    sector.set([0, 2, lba, 2], 12);
    sector[18] = sector[22] = 0x08;
    for (let i = 24; i < 2072; i++) sector[i] = lba % 3 === 0 ? random() : (i * lba + seed) & 0xff;
  }
  const audio = new DataView(bin.buffer, dataSectors * SECTOR_SIZE);
  for (let i = 0; i < (audioSectors * SECTOR_SIZE) / 4; i++) {
    audio.setInt16(i * 4, Math.round(Math.sin(i / 20) * 12000), true);
    audio.setInt16(i * 4 + 2, Math.round(Math.cos(i / 31) * 9000 + random()), true);
  }
  const cue = 'FILE "disc.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:08:00\n    INDEX 01 00:10:00\n';
  return { bin, cue };
}

/** Throws unless both discs have the same tracks and every sector reads the same. */
export function expectSameDisc(actual: Disc, expected: Disc): void {
  if (JSON.stringify(actual.tracks) !== JSON.stringify(expected.tracks)) throw new Error(`tracks differ: ${JSON.stringify(actual.tracks)}`);
  if (actual.leadOut !== expected.leadOut) throw new Error(`lead-out ${actual.leadOut}, expected ${expected.leadOut}`);
  const a = new Uint8Array(SECTOR_SIZE);
  const b = new Uint8Array(SECTOR_SIZE);
  for (let lba = 0; lba < expected.leadOut; lba++) {
    expected.readSector(lba, a);
    actual.readSector(lba, b);
    if (!a.every((byte, i) => byte === b[i])) throw new Error(`sector ${lba} differs`);
  }
}
