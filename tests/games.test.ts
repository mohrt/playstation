import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Disc, discInfo, MemorySource } from '../src/disc/disc';
import { PlayStation } from '../src/playstation';
import { checkBios } from '../src/storage/bios-store';
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

const BIOS_DIR = join(ROOT, 'roms', 'bios');
const usableBios = (name: string) => {
  if (statSync(join(BIOS_DIR, name)).size !== 0x80000) return false;
  try {
    checkBios(new Uint8Array(readFileSync(join(BIOS_DIR, name))));
    return true;
  } catch {
    return false;
  }
};
const userBioses = existsSync(BIOS_DIR) ? readdirSync(BIOS_DIR).filter(usableBios) : [];

// Your own BIOS images in roms/bios/ (never committed) are booted to their menu with no disc in.
describe.skipIf(userBioses.length === 0)('real BIOSes', () => {
  it.each(userBioses)('%s gets past the Sony logo to its menu', (name) => {
    const machine = new PlayStation();
    machine.loadBios(new Uint8Array(readFileSync(join(BIOS_DIR, name))));
    machine.powerOn();
    for (let frame = 0; frame < 400; frame++) machine.runFrame();
    const logo = machine.gpu.framebuffer.slice();
    for (let frame = 400; frame < 1500; frame++) machine.runFrame();
    let changed = 0;
    for (let i = 0; i < logo.length; i++) if (logo[i] !== machine.gpu.framebuffer[i]) changed++;
    expect(changed / logo.length).toBeGreaterThan(0.3);
    expect(lit(machine)).toBeGreaterThan(0.2);
  });
});

describe.skipIf(!haveBios || manifest.length === 0)('free games boot through OpenBIOS', () => {
  it.each(manifest.map((game) => [game.title, game.file]))('%s reaches its title screen', (_title, file) => {
    const disc = Disc.fromImage(new MemorySource(new Uint8Array(readFileSync(join(GAMES_DIR, file)))));
    const machine = bootedMachine();
    machine.insertDisc(disc, discInfo(disc).region);
    machine.powerOn();
    expect(framesToPicture(machine, 1500)).toBeLessThan(1500);
  });
});

// Your own discs in roms/ (never committed) are booted too.
const discs = romDiscs();
describe.skipIf(!haveBios || discs.length === 0)('your discs boot through OpenBIOS', () => {
  it.each(discs.map((path) => [basename(path), path]))('%s draws its first pictures', { timeout: 120_000 }, (_name, path) => {
    const media = openDisc(path);
    if (media.kind !== 'disc') throw new Error('not a disc');
    const machine = bootedMachine();
    machine.insertDisc(media.disc, media.info.region);
    machine.powerOn();
    expect(framesToPicture(machine, 3600)).toBeLessThan(3600);
  });
});
