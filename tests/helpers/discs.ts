import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ChdFile } from '../../src/disc/chd';
import { Disc, type ByteSource } from '../../src/disc/disc';
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

/** The discs in roms/ (your own; never committed): every .cue, and .bin/.iso files without one. */
export function romDiscs(): string[] {
  const dir = join(ROOT, 'roms');
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const cues = names.filter((name) => /\.(cue|chd)$/i.test(name));
  const covered = new Set(cues.flatMap((cue) => [...readFileSync(join(dir, cue), 'utf8').matchAll(/FILE\s+"([^"]+)"/gi)].map((m) => basename(m[1]).toLowerCase())));
  const images = names.filter((name) => /\.(bin|iso|img)$/i.test(name) && !covered.has(name.toLowerCase()));
  return [...cues, ...images].map((name) => join(dir, name));
}
