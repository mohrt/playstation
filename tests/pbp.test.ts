import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { bcd, Disc, LEAD_IN, MemorySource, msf, SECTOR_SIZE } from '../src/disc/disc';
import { PbpFile } from '../src/disc/pbp';
import { expectSameDisc, makeTestImage } from './helpers/discs';

const BLOCK_SIZE = 16 * SECTOR_SIZE;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A PSISOIMG as popstation writes it: header, disc ID, TOC, block index, then the blocks (some stored, most deflated). */
function psisoImage(bin: Uint8Array, tracks: { audio: boolean; start: number }[], discId: string): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (let at = 0; at < bin.length; at += BLOCK_SIZE) {
    const block = new Uint8Array(BLOCK_SIZE);
    block.set(bin.subarray(at, at + BLOCK_SIZE));
    blocks.push(blocks.length % 5 === 4 ? block : deflateRawSync(block, { level: 9 }));
  }
  const header = new Uint8Array(0x100000);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('PSISOIMG0000'));
  view.setUint32(12, blocks.reduce((sum, block) => sum + block.length, 0), true);
  header.set(new TextEncoder().encode(`_${discId.slice(0, 4)}_${discId.slice(4)}`), 0x400);
  const leadOut = bin.length / SECTOR_SIZE;
  const entries: [number, number, number, number, number][] = [
    [0x41, 0xa0, 1, 0x20, 0],
    [0x41, 0xa1, bcd(tracks.length), 0, 0],
    [0x41, 0xa2, ...msf(leadOut + LEAD_IN).map(bcd)] as [number, number, number, number, number],
    ...tracks.map((track, i) => [track.audio ? 0x01 : 0x41, bcd(i + 1), ...msf(track.start + LEAD_IN).map(bcd)] as [number, number, number, number, number]),
  ];
  entries.forEach(([control, point, m, s, f], i) => header.set([control, 0, point, 0, 0, 0, 0, m, s, f], 0x800 + i * 10));
  let offset = 0;
  blocks.forEach((block, i) => {
    view.setUint32(0x4000 + i * 32, offset, true);
    view.setUint16(0x4000 + i * 32 + 4, block.length, true);
    offset += block.length;
  });
  return concat([header, ...blocks]);
}

/** PARAM.SFO with just a TITLE. */
function paramSfo(title: string): Uint8Array {
  const value = new TextEncoder().encode(`${title}\0`);
  const sfo = new Uint8Array(0x14 + 16 + 8 + 128);
  const view = new DataView(sfo.buffer);
  sfo.set(new TextEncoder().encode('\0PSF'));
  view.setUint32(0x08, 0x24, true);
  view.setUint32(0x0c, 0x2c, true);
  view.setUint32(0x10, 1, true);
  view.setUint16(0x14, 0, true);
  view.setUint32(0x18, value.length, true);
  view.setUint32(0x1c, 128, true);
  view.setUint32(0x20, 0, true);
  sfo.set(new TextEncoder().encode('TITLE\0'), 0x24);
  sfo.set(value, 0x2c);
  return sfo;
}

/** An EBOOT.PBP with one disc (a bare PSISOIMG) or several (behind a PSTITLEIMG). */
function pbp(title: string, discs: Uint8Array[]): Uint8Array {
  const sfo = paramSfo(title);
  const header = new Uint8Array(0x28);
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('\0PBP'));
  view.setUint32(4, 0x10000, true);
  for (let i = 0; i < 7; i++) view.setUint32(8 + i * 4, i === 0 ? 0x28 : 0x28 + sfo.length, true);
  const psar = (0x28 + sfo.length + 0xffff) & ~0xffff;
  view.setUint32(0x24, psar, true);
  const padding = new Uint8Array(psar - 0x28 - sfo.length);
  if (discs.length === 1) return concat([header, sfo, padding, discs[0]]);
  const titleImage = new Uint8Array(0x8000);
  titleImage.set(new TextEncoder().encode('PSTITLEIMG000000'));
  let at = titleImage.length;
  discs.forEach((disc, i) => {
    new DataView(titleImage.buffer).setUint32(0x200 + i * 4, at, true);
    at += disc.length;
  });
  return concat([header, sfo, padding, titleImage, ...discs]);
}

const testTracks = [
  { audio: false, start: 0 },
  { audio: true, start: 750 },
];

describe('PBP images', () => {
  it('read the same sectors and tracks as the BIN/CUE they were made from', () => {
    const { bin, cue } = makeTestImage();
    const file = new PbpFile(new MemorySource(pbp('Test Disc', [psisoImage(bin, testTracks, 'SLUS00001')])));
    expect(file.discCount).toBe(1);
    expect(file.title).toBe('Test Disc');
    const image = file.disc(0);
    expect(image.discId).toBe('SLUS00001');
    expectSameDisc(Disc.fromPbp(image), Disc.fromCue(cue, new Map([['disc.bin', new MemorySource(bin)]])));
  });

  it('hold every disc of a multi-disc game', () => {
    const images = [makeTestImage(1), makeTestImage(2)];
    const file = new PbpFile(new MemorySource(pbp('Two Discs', images.map((image, i) => psisoImage(image.bin, testTracks, `SLUS0000${i + 1}`)))));
    expect(file.discCount).toBe(2);
    images.forEach((image, i) => {
      expect(file.disc(i).discId).toBe(`SLUS0000${i + 1}`);
      expectSameDisc(Disc.fromPbp(file.disc(i)), Disc.fromCue(image.cue, new Map([['disc.bin', new MemorySource(image.bin)]])));
    });
  });

  it('refuse encrypted and non-PlayStation PBPs', () => {
    const { bin } = makeTestImage();
    const disc = psisoImage(bin, testTracks, 'SLUS00001');
    disc.fill(0x5a, 0x4000, 0x4020);
    expect(() => new PbpFile(new MemorySource(pbp('Encrypted', [disc]))).disc(0)).toThrow(/encrypted/);
    const game = pbp('PSP game', [disc]);
    game.set(new TextEncoder().encode('NPUMDIMG'), new DataView(game.buffer).getUint32(0x24, true));
    expect(() => new PbpFile(new MemorySource(game))).toThrow(/no PlayStation disc/);
    expect(() => new PbpFile(new MemorySource(new Uint8Array(0x100)))).toThrow(/isn't a PBP/);
  });
});
