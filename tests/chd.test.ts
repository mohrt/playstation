import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ChdFile } from '../src/disc/chd';
import { Disc, MemorySource } from '../src/disc/disc';
import { inflateRaw } from '../src/disc/inflate';
import { expectSameDisc, FileSource, makeTestImage } from './helpers/discs';

const haveChdman = (() => {
  try {
    execFileSync('chdman', ['--help'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
})();

describe('CHD images', () => {
  it.skipIf(!haveChdman)('read the same sectors as the BIN/CUE they were made from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psx-chd-'));
    try {
      const { bin, cue } = makeTestImage();
      writeFileSync(join(dir, 'disc.bin'), bin);
      writeFileSync(join(dir, 'disc.cue'), cue);
      execFileSync('chdman', ['createcd', '-i', join(dir, 'disc.cue'), '-o', join(dir, 'disc.chd'), '-f'], { stdio: 'ignore' });
      const expected = Disc.fromCue(cue, new Map([['disc.bin', new MemorySource(bin)]]));
      expectSameDisc(Disc.fromChd(new ChdFile(new FileSource(join(dir, 'disc.chd')))), expected);
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
