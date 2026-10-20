import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChdFile } from '../src/disc/chd';
import { Disc, MemorySource, SECTOR_SIZE } from '../src/disc/disc';
import { inflateRaw } from '../src/disc/inflate';
import { FileSource } from './helpers/discs';
import { deflateRawSync } from 'node:zlib';

const haveChdman = (() => {
  try {
    execFileSync('chdman', ['--help'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
})();

/** A two-track disc image: mode 2 data sectors with varied contents, then CD audio with a pregap. */
function makeImage(): { bin: Uint8Array; cue: string } {
  const dataSectors = 600;
  const audioSectors = 900;
  const bin = new Uint8Array((dataSectors + audioSectors) * SECTOR_SIZE);
  let seed = 1;
  const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  for (let lba = 0; lba < dataSectors; lba++) {
    const sector = bin.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE);
    sector.set([0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0]);
    sector.set([0, 2, lba, 2], 12);
    sector[18] = sector[22] = 0x08;
    for (let i = 24; i < 2072; i++) sector[i] = lba % 3 === 0 ? random() : (i * lba) & 0xff;
  }
  const audio = new DataView(bin.buffer, dataSectors * SECTOR_SIZE);
  for (let i = 0; i < (audioSectors * SECTOR_SIZE) / 4; i++) {
    audio.setInt16(i * 4, Math.round(Math.sin(i / 20) * 12000), true);
    audio.setInt16(i * 4 + 2, Math.round(Math.cos(i / 31) * 9000 + random()), true);
  }
  const cue = 'FILE "disc.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:08:00\n    INDEX 01 00:10:00\n';
  return { bin, cue };
}

describe('CHD images', () => {
  it.skipIf(!haveChdman)('read the same sectors as the BIN/CUE they were made from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psx-chd-'));
    try {
      const { bin, cue } = makeImage();
      writeFileSync(join(dir, 'disc.bin'), bin);
      writeFileSync(join(dir, 'disc.cue'), cue);
      execFileSync('chdman', ['createcd', '-i', join(dir, 'disc.cue'), '-o', join(dir, 'disc.chd'), '-f'], { stdio: 'ignore' });
      const expected = Disc.fromCue(cue, new Map([['disc.bin', new MemorySource(bin)]]));
      const chd = new ChdFile(new FileSource(join(dir, 'disc.chd')));
      const disc = Disc.fromChd(chd);
      expect(disc.tracks).toEqual(expected.tracks);
      expect(disc.leadOut).toBe(expected.leadOut);
      const a = new Uint8Array(SECTOR_SIZE);
      const b = new Uint8Array(SECTOR_SIZE);
      for (let lba = 0; lba < expected.leadOut; lba++) {
        expected.readSector(lba, a);
        disc.readSector(lba, b);
        if (!a.every((byte, i) => byte === b[i])) throw new Error(`sector ${lba} differs`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inflates raw DEFLATE data (stored, fixed and dynamic blocks)', () => {
    const text = new TextEncoder().encode('PlayStation '.repeat(500) + Array.from({ length: 3000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join(''));
    for (const level of [0, 1, 9]) {
      const out = new Uint8Array(text.length);
      inflateRaw(deflateRawSync(text, { level }), out);
      expect(out).toEqual(text);
    }
  });

  it('refuses files that are not CD CHDs', () => {
    expect(() => new ChdFile(new MemorySource(new Uint8Array(124)))).toThrow(/not a CHD/);
  });
});
