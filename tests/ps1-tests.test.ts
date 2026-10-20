import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { haveBios, haveTests, runExe, TESTS_DIR } from './helpers/machine';
import { compareVram } from './helpers/vram-compare';

/** The pass/fail lines a test printed (the console's logs start each line with "% "). */
const results = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/^% ?/, '').trim())
    .filter((line) => /^(pass|fail) - /.test(line));

const testExe = (name: string, file = name.split('/').pop()!) => join(TESTS_DIR, name, `${file}.exe`);
const done = (tty: string) => /\bDone\b/.test(tty);

describe.skipIf(!haveBios || !haveTests)('ps1-tests (JaCzekanski) through OpenBIOS', () => {
  it.each(['cpu/cop', 'dma/otc-test', 'dma/dpcr'])('%s passes what the console passes', (name) => {
    const run = runExe(testExe(name), 600, done);
    const expected = results(readFileSync(join(TESTS_DIR, name, 'psx.log'), 'utf8'));
    expect(expected.length).toBeGreaterThan(0);
    // The logs are from an older build of the tests, which had fewer cases.
    const ours = results(run.tty);
    for (const line of expected) expect(ours).toContain(line);
    expect(ours.filter((line) => line.startsWith('fail'))).toEqual([]);
  });

  it('gte/test-all passes every GTE command and register test', () => {
    const run = runExe(testExe('gte/test-all'), 3000, done);
    expect(run.tty).toMatch(/Failed tests: 0\b/);
    expect(run.tty).toMatch(/Passed tests: 1150\b/);
  });

  it('cpu/io-access-bitwidth: narrow writes to I/O carry the whole register', () => {
    const run = runExe(testExe('cpu/io-access-bitwidth'), 600, done);
    expect(run.tty).toMatch(/DMA0_ADDR\s+\(0x1f801080\)\s+0x345678\s+0x345678\s+0x345678/);
    expect(run.tty).toMatch(/DMAC_CTRL\s+\(0x1f8010f0\)\s+0x12345678\s+0x12345678\s+0x12345678/);
    expect(run.tty).toMatch(/EXPANSION2\s+\(0x1f802000\)\s+0xffffffff/);
  });

  // Share of VRAM drawn exactly as on the console (the rest is within one colour step).
  const vramTests: [string, string, number][] = [
    ['gpu/triangle', 'triangle', 0.99],
    ['gpu/quad', 'quad', 1],
    ['gpu/rectangles', 'rectangles', 1],
    ['gpu/lines', 'lines', 0.998],
    ['gpu/transparency', 'transparency', 1],
    ['gpu/texture-flip', 'texture-flip', 1],
    ['gpu/clipping', 'clipping', 1],
    ['gpu/uv-interpolation', 'uv-interpolation', 0.96],
    ['gpu/texture-overflow', 'texture-overflow', 1],
    ['gpu/vram-to-vram-overlap', 'vram-to-vram-overlap', 1],
    ['gpu/clut-cache', 'clut-cache', 0.998],
    ['mdec/4bit', '4bit', 0.9999],
    ['mdec/8bit', '8bit', 0.9999],
  ];
  it.each(vramTests)('%s draws VRAM as the console does', (name, file, share) => {
    const run = runExe(testExe(name, file), 300, done);
    const { same } = compareVram(run.machine.gpu.vram, join(TESTS_DIR, name, 'vram.png'));
    expect(same).toBeGreaterThanOrEqual(share);
  });

  it.each([
    ['frame-15bit-dma', 'vram-15bit.png', 0.96],
    ['frame-24bit-dma', 'vram-24bit.png', 0.89],
  ])('mdec/frame %s decodes a frame as the console does', (file, png, share) => {
    const run = runExe(testExe('mdec/frame', file), 600, done);
    const { same, close } = compareVram(run.machine.gpu.vram, join(TESTS_DIR, 'mdec/frame', png));
    expect(same).toBeGreaterThanOrEqual(share);
    expect(same + close).toBeGreaterThanOrEqual(0.9);
  });

  it('timers count the system clock, dot clock and blanks at the console\'s rates', () => {
    const run = runExe(join(TESTS_DIR, 'timers', 'timers.exe'), 600, done);
    const line = (label: string) => run.tty.split('\n').find((text) => text.startsWith(label)) ?? '';
    const values = (label: string) =>
      line(label)
        .split(':')
        .pop()!
        .split(',')
        .map((text) => text.trim())
        .filter(Boolean)
        .map(Number);
    const near = (label: string, expected: number, tolerance: number) => {
      const measured = values(label);
      expect(measured.length).toBe(10);
      for (const value of measured) expect(Math.abs(value - expected)).toBeLessThanOrEqual(tolerance);
    };
    near('Timer0, clock:   System clock, 1000 cycles delay', 1011, 5);
    near('Timer0, clock:      Dot clock, 5000 cycles delay', 983, 5);
    near('Timer2, clock: System clock/8, 5000 cycles delay', 626, 2);
    expect(values('Timer1, clock:         Hblank,       frame delay').slice(1)).toEqual(Array(9).fill(263));
  });
});
