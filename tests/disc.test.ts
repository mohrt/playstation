import { describe, expect, it } from 'vitest';
import { Disc, discInfo, LEAD_IN, MemorySource, SECTOR_SIZE } from '../src/disc/disc';

/** A raw sector whose data bytes all hold `fill` (and whose first byte says which sector it is). */
function rawSector(lba: number, fill: number): Uint8Array {
  const sector = new Uint8Array(SECTOR_SIZE);
  sector.fill(fill);
  sector[0] = lba & 0xff;
  return sector;
}

function image(sectors: number, firstLba: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(sectors * SECTOR_SIZE);
  for (let i = 0; i < sectors; i++) bytes.set(rawSector(firstLba + i, fill), i * SECTOR_SIZE);
  return bytes;
}

/** A tiny ISO 9660 data track: the PVD at 16, the root directory at 18, SYSTEM.CNF at 19. */
function isoWithSystemCnf(text: string): Uint8Array {
  const sectors = 24;
  const bytes = new Uint8Array(sectors * 2048);
  const pvd = bytes.subarray(16 * 2048);
  pvd[0] = 1;
  pvd.set(new TextEncoder().encode('CD001'), 1);
  const root = pvd.subarray(156);
  root[0] = 34;
  new DataView(root.buffer, root.byteOffset).setUint32(2, 18, true);
  new DataView(root.buffer, root.byteOffset).setUint32(10, 2048, true);
  const dir = bytes.subarray(18 * 2048);
  const name = new TextEncoder().encode('SYSTEM.CNF;1');
  dir[0] = 33 + name.length + 1;
  new DataView(dir.buffer, dir.byteOffset).setUint32(2, 19, true);
  new DataView(dir.buffer, dir.byteOffset).setUint32(10, text.length, true);
  dir[32] = name.length;
  dir.set(name, 33);
  bytes.set(new TextEncoder().encode(text), 19 * 2048);
  return bytes;
}

describe('disc images', () => {
  it('lays out a CUE sheet: index 0 pregaps in the file, PREGAP silence outside it, and several files', () => {
    const cue = [
      'FILE "game.bin" BINARY',
      '  TRACK 01 MODE2/2352',
      '    INDEX 01 00:00:00',
      '  TRACK 02 AUDIO',
      '    INDEX 00 00:00:10',
      '    INDEX 01 00:00:12',
      'FILE "track3.bin" BINARY',
      '  TRACK 03 AUDIO',
      '    PREGAP 00:00:05',
      '    INDEX 01 00:00:00',
    ].join('\n');
    const files = new Map([
      ['game.bin', new MemorySource(image(20, 0, 0x11))],
      ['track3.bin', new MemorySource(image(8, 100, 0x33))],
    ]);
    const disc = Disc.fromCue(cue, files);
    expect(disc.tracks.map((t) => [t.number, t.audio, t.start, t.length])).toEqual([
      [1, false, 0, 10],
      [2, true, 12, 8],
      [3, true, 25, 8],
    ]);
    expect(disc.leadOut).toBe(33);
    const out = new Uint8Array(SECTOR_SIZE);
    disc.readSector(12, out);
    expect(out[0]).toBe(12);
    disc.readSector(22, out);
    expect(out[1]).toBe(0); // the PREGAP is silence
    disc.readSector(25, out);
    expect([out[0], out[1]]).toEqual([100, 0x33]);
    expect(disc.trackAt(11).number).toBe(2);
    expect(disc.readSector(40, out)).toBe(false);
  });

  it('asks for the files a CUE sheet names', () => {
    expect(() => Disc.fromCue('FILE "missing.bin" BINARY\n TRACK 01 MODE2/2352\n INDEX 01 00:00:00', new Map())).toThrow(/missing\.bin/);
  });

  it('gives ISO images sector headers, and finds the game in SYSTEM.CNF', () => {
    const iso = isoWithSystemCnf('BOOT = cdrom:\\SLES_123.45;1\r\nTCB = 4\r\n');
    const disc = Disc.fromImage(new MemorySource(iso));
    const out = new Uint8Array(SECTOR_SIZE);
    disc.readSector(16, out);
    // Sync, then 00:02:16 in BCD, mode 2, and a form 1 data subheader.
    expect(Array.from(out.subarray(0, 12))).toEqual([0, ...Array(10).fill(0xff), 0]);
    expect(Array.from(out.subarray(12, 16))).toEqual([0x00, 0x02, 0x16, 0x02]);
    expect(out[18]).toBe(0x08);
    expect(String.fromCharCode(...out.subarray(25, 30))).toBe('CD001');
    expect(discInfo(disc)).toEqual({ bootFile: 'SLES_123.45', serial: 'SLES-12345', region: 'pal' });
  });

  it('takes a raw .bin as one data track', () => {
    const bin = image(30, 0, 0);
    bin.set([0, ...Array(10).fill(0xff), 0]);
    const disc = Disc.fromImage(new MemorySource(bin));
    expect(disc.tracks).toEqual([{ number: 1, audio: false, start: 0, length: 30 }]);
    expect(LEAD_IN).toBe(150);
  });
});
