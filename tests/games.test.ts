import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Disc, discInfo, MemorySource } from '../src/disc/disc';
import type { PlayStation } from '../src/playstation';
import { openDisc, romDiscs } from './helpers/discs';
import { bootedMachine, haveBios, ROOT } from './helpers/machine';

const GAMES_DIR = join(ROOT, 'public', 'games');
const manifest = existsSync(join(GAMES_DIR, 'index.json')) ? (JSON.parse(readFileSync(join(GAMES_DIR, 'index.json'), 'utf8')) as { games: { title: string; file: string }[] }).games : [];

/** Share of the picture that isn't black. */
function lit(machine: PlayStation): number {
  const { framebuffer, frameWidth, frameHeight } = machine.gpu;
  let count = 0;
  for (let i = 0; i < frameWidth * frameHeight; i++) if ((framebuffer[i] & 0xffffff) > 0x101010) count++;
  return count / (frameWidth * frameHeight);
}

/** Runs until the game shows a mostly drawn picture; returns the frame it took. */
function framesToPicture(machine: PlayStation, maxFrames: number): number {
  for (let frame = 1; frame <= maxFrames; frame++) {
    machine.runFrame();
    if (frame % 60 === 0 && lit(machine) > 0.2 && machine.gpu.frameWidth !== 640) return frame;
  }
  return Infinity;
}

describe.skipIf(!haveBios)('games boot through OpenBIOS', () => {
  it.each(manifest.map((game) => [game.title, game.file]))('%s (free game) reaches its title screen', (_title, file) => {
    const disc = Disc.fromImage(new MemorySource(new Uint8Array(readFileSync(join(GAMES_DIR, file)))));
    const machine = bootedMachine();
    machine.insertDisc(disc, discInfo(disc).region);
    machine.powerOn();
    expect(framesToPicture(machine, 1500)).toBeLessThan(1500);
  });

  // Your own discs in roms/ (never committed) are booted too.
  it.each(romDiscs().map((path) => [basename(path), path]))('%s (from roms/) draws its first pictures', { timeout: 120_000 }, (_name, path) => {
    const media = openDisc(path);
    if (media.kind !== 'disc') throw new Error('not a disc');
    const machine = bootedMachine();
    machine.insertDisc(media.disc, media.info.region);
    machine.powerOn();
    expect(framesToPicture(machine, 3600)).toBeLessThan(3600);
  });
});
