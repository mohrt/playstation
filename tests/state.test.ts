import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Disc, discInfo, MemorySource } from '../src/disc/disc';
import { captureState, restoreState } from '../src/state/snapshot';
import { decodeSession, encodeSession } from '../src/storage/save-states';
import { bootedMachine, haveBios, ROOT } from './helpers/machine';

const TETRADE = join(ROOT, 'public', 'games', 'tetrade.bin');

describe.skipIf(!haveBios || !existsSync(TETRADE))('save states', () => {
  it('resume exactly where they were saved', { timeout: 60_000 }, async () => {
    const disc = Disc.fromImage(new MemorySource(new Uint8Array(readFileSync(TETRADE))));
    const machine = bootedMachine();
    machine.insertDisc(disc, discInfo(disc).region);
    machine.powerOn();
    for (let i = 0; i < 700; i++) machine.runFrame();

    const bytes = await encodeSession({ machine: captureState(machine), media: { title: 'Tetrade', discId: 'tetrade' } });
    expect(bytes.length).toBeLessThan(2_000_000);
    for (let i = 0; i < 120; i++) machine.runFrame();
    const expected = machine.gpu.framebuffer.slice();
    const expectedPc = machine.cpu.pc;

    const session = await decodeSession(bytes);
    expect(session.media.discId).toBe('tetrade');
    restoreState(machine, session.machine);
    for (let i = 0; i < 120; i++) machine.runFrame();
    expect(machine.cpu.pc).toBe(expectedPc);
    expect(machine.gpu.framebuffer).toEqual(expected);
  });
});
