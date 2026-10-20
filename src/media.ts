import { ChdFile } from './disc/chd';
import { BlobSource, Disc, discInfo, type ByteSource, type DiscInfo } from './disc/disc';
import { PbpFile } from './disc/pbp';
import { isPsExe, parsePsExe, type PsExe } from './exe';

export const STATE_EXTENSION = '.psxstate';
export const MEMORY_CARD_EXTENSIONS = ['.mcr', '.mcd', '.mem', '.gme', '.srm', '.mc'];
const DISC_EXTENSIONS = ['.cue', '.bin', '.img', '.iso', '.chd', '.pbp'];
const EXE_EXTENSIONS = ['.exe', '.psx', '.ps-exe'];

const extension = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

export type FileKind = 'disc' | 'exe' | 'state' | 'memory-card' | 'other';

/** What a dropped file looks like it is, by its name. */
export function fileKind(name: string): FileKind {
  const ext = extension(name);
  if (DISC_EXTENSIONS.includes(ext)) return 'disc';
  if (EXE_EXTENSIONS.includes(ext)) return 'exe';
  if (ext === STATE_EXTENSION) return 'state';
  if (MEMORY_CARD_EXTENSIONS.includes(ext)) return 'memory-card';
  return 'other';
}

/** "Some Game (USA) (Disc 1).cue" → "Some Game (USA) (Disc 1)". */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || name;
}

/** A title without its disc number: "Final Fantasy VII (Disc 2)" → "final fantasy vii". */
export function gameName(title: string): string {
  return title
    .replace(/[([]?\b(disc|disk|cd)\s*\d+(\s*of\s*\d+)?[)\]]?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type LoadedMedia =
  | { kind: 'disc'; disc: Disc; info: DiscInfo; title: string; details: string; id: string; pbpDisc?: { number: number; count: number } }
  | { kind: 'exe'; exe: PsExe; bytes: Uint8Array; title: string; details: string };

declare class FileReaderSync {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
  readAsText(blob: Blob): string;
}

const REGION_NAMES = { 'ntsc-u': 'NTSC-U', 'ntsc-j': 'NTSC-J', pal: 'PAL' } as const;

/**
 * Makes a disc or a program from dropped files (in the worker, where files
 * can be read synchronously): a CUE sheet with its BIN files, a CHD, a PBP,
 * a single BIN or ISO image, or a PS-EXE. `pbpDisc` picks the disc of a
 * multi-disc PBP (counting from 0, and wrapping around).
 */
export function loadMedia(files: File[], pbpDisc = 0): LoadedMedia {
  const reader = new FileReaderSync();
  const chd = files.find((file) => extension(file.name) === '.chd');
  if (chd) return discMedia(Disc.fromChd(new ChdFile(new BlobSource(chd))), chd.name);
  const pbp = files.find((file) => extension(file.name) === '.pbp');
  if (pbp) {
    const pbpFile = new PbpFile(new BlobSource(pbp));
    const number = pbpDisc % pbpFile.discCount;
    const media = discMedia(Disc.fromPbp(pbpFile.disc(number)), pbp.name);
    media.title = pbpFile.title ?? media.title;
    if (media.kind === 'disc') media.pbpDisc = { number, count: pbpFile.discCount };
    if (pbpFile.discCount > 1) {
      media.title += ` (Disc ${number + 1})`;
      media.details += ` · disc ${number + 1} of ${pbpFile.discCount}`;
    }
    return media;
  }
  const cue = files.find((file) => extension(file.name) === '.cue');
  if (cue) {
    const sources = new Map<string, ByteSource>(files.map((file) => [file.name, new BlobSource(file)]));
    const disc = Disc.fromCue(reader.readAsText(cue), sources);
    return discMedia(disc, cue.name);
  }
  const image = files.find((file) => DISC_EXTENSIONS.includes(extension(file.name)));
  // Programs are recognised by their header, whatever they are called.
  const program = files.find((file) => file !== image && file.size <= 0x200800 && isPsExe(new Uint8Array(reader.readAsArrayBuffer(file.slice(0, 0x800)))));
  if (program) {
    const bytes = new Uint8Array(reader.readAsArrayBuffer(program));
    const exe = parsePsExe(bytes);
    const details = `PS-EXE · ${Math.round(exe.text.length / 1024)}K at ${(exe.loadAddress >>> 0).toString(16)}`;
    return { kind: 'exe', exe, bytes, title: titleFromFileName(program.name), details };
  }
  if (!image) throw new Error(`${files[0]?.name ?? 'That file'} isn't a disc image (.cue, .chd, .pbp, .bin, .iso) or a PlayStation program (.exe).`);
  if (image.size < 2048 * 16) throw new Error(`${image.name} is too small to be a disc image.`);
  return discMedia(Disc.fromImage(new BlobSource(image)), image.name);
}

export function discMedia(disc: Disc, fileName: string): LoadedMedia {
  const info = discInfo(disc);
  const title = titleFromFileName(fileName);
  const audioTracks = disc.tracks.filter((track) => track.audio).length;
  const parts = [info.serial ?? 'no serial', REGION_NAMES[info.region]];
  parts.push(audioTracks ? `${disc.tracks.length} tracks (${audioTracks} audio)` : `${disc.tracks.length} track${disc.tracks.length === 1 ? '' : 's'}`);
  parts.push(`${Math.round((disc.leadOut * 2352) / 0x100000)} MB`);
  if (!info.bootFile) parts.push('no SYSTEM.CNF');
  return { kind: 'disc', disc, info, title, details: parts.join(' · '), id: info.serial ?? fileName.toLowerCase() };
}
