import { describe, expect, it } from 'vitest';
import { PlayStation } from '../src/playstation';
import { asm } from './helpers/asm';

const ORIGIN = 0x80010000;
const DATA = 0x80020000;

/** A console with `program` in RAM at ORIGIN and the CPU about to run it (no BIOS needed). */
function machineWith(program: number[]): PlayStation {
  const machine = new PlayStation();
  machine.powerOn();
  const ram = new DataView(machine.bus.ram8.buffer);
  program.forEach((word, index) => ram.setUint32((ORIGIN & 0x1fffff) + index * 4, word, true));
  machine.cpu.sr = 0; // exceptions to 0x80000080
  machine.cpu.jump(ORIGIN);
  return machine;
}

function steps(machine: PlayStation, count: number): void {
  for (let i = 0; i < count; i++) machine.cpu.step();
}

describe('R3000A', () => {
  it('lets the instruction after a load see the old value (load delay slot)', () => {
    const m = machineWith([asm.lw(2, 1, 0), asm.addu(3, 2, 0), asm.addu(4, 2, 0)]);
    m.bus.write32(DATA, 0x1234);
    m.cpu.r[1] = DATA | 0;
    m.cpu.r[2] = 7;
    steps(m, 3);
    expect(m.cpu.r[3]).toBe(7);
    expect(m.cpu.r[4]).toBe(0x1234);
  });

  it('keeps a register written in the load delay slot over the load', () => {
    const m = machineWith([asm.lw(2, 1, 0), asm.addiu(2, 0, 5), asm.nop()]);
    m.bus.write32(DATA, 0x1234);
    m.cpu.r[1] = DATA | 0;
    steps(m, 3);
    expect(m.cpu.r[2]).toBe(5);
  });

  it('runs the branch delay slot, and links past it', () => {
    const m = machineWith([asm.beq(0, 0, 2), asm.addiu(5, 0, 1), asm.addiu(6, 0, 1), asm.addiu(7, 0, 1), asm.bltzal(8, 10), asm.nop()]);
    m.cpu.r[8] = -1;
    steps(m, 4);
    expect([m.cpu.r[5], m.cpu.r[6], m.cpu.r[7]]).toEqual([1, 0, 1]);
    expect(m.cpu.r[31] >>> 0).toBe(ORIGIN + 6 * 4);
  });

  it('multiplies into 64 bits, signed and unsigned', () => {
    const m = machineWith([asm.mult(1, 2), asm.mfhi(3), asm.mflo(4), asm.multu(1, 2), asm.mfhi(5), asm.mflo(6)]);
    m.cpu.r[1] = -3;
    m.cpu.r[2] = 0x7fffffff;
    steps(m, 6);
    const signed = -3n * 0x7fffffffn;
    expect(BigInt(m.cpu.r[3]) * 2n ** 32n + BigInt(m.cpu.r[4] >>> 0)).toBe(signed);
    const unsigned = 0xfffffffdn * 0x7fffffffn;
    expect(BigInt(m.cpu.r[5] >>> 0) * 2n ** 32n + BigInt(m.cpu.r[6] >>> 0)).toBe(unsigned);
  });

  it('gives the hardware results for division by zero and overflow', () => {
    const m = machineWith([asm.div(1, 0), asm.mflo(3), asm.mfhi(4), asm.div(2, 5), asm.mflo(6), asm.mfhi(7), asm.divu(1, 0), asm.mflo(8)]);
    m.cpu.r[1] = -9;
    m.cpu.r[2] = -0x80000000;
    m.cpu.r[5] = -1;
    steps(m, 8);
    expect([m.cpu.r[3], m.cpu.r[4]]).toEqual([1, -9]);
    expect([m.cpu.r[6], m.cpu.r[7]]).toEqual([-0x80000000, 0]);
    expect(m.cpu.r[8]).toBe(-1);
  });

  it('merges unaligned words with LWL/LWR and SWL/SWR', () => {
    const m = machineWith([asm.lwr(2, 1, 1), asm.lwl(2, 1, 4), asm.nop(), asm.swr(3, 1, 9), asm.swl(3, 1, 12)]);
    m.bus.write32(DATA, 0x44332211);
    m.bus.write32(DATA + 4, 0x88776655);
    m.cpu.r[1] = DATA | 0;
    m.cpu.r[3] = 0xaabbccdd | 0;
    steps(m, 5);
    expect(m.cpu.r[2] >>> 0).toBe(0x55443322);
    expect(m.bus.read32(DATA + 8) >>> 0).toBe(0xbbccdd00);
    expect(m.bus.read32(DATA + 12) >>> 0).toBe(0x000000aa);
  });

  it('traps signed overflow in ADD, leaving the destination alone', () => {
    const m = machineWith([asm.add(3, 1, 2)]);
    m.cpu.r[1] = 0x7fffffff;
    m.cpu.r[2] = 1;
    m.cpu.r[3] = 42;
    steps(m, 1);
    expect(m.cpu.r[3]).toBe(42);
    expect((m.cpu.cause >> 2) & 0x1f).toBe(0xc);
    expect(m.cpu.epc >>> 0).toBe(ORIGIN);
    expect(m.cpu.pc >>> 0).toBe(0x80000080);
  });

  it('takes interrupts with EPC on the branch when they arrive in a delay slot', () => {
    const m = machineWith([asm.beq(0, 0, 4), asm.nop(), asm.nop()]);
    m.cpu.sr = 0x401; // interrupts enabled, IRQ line unmasked
    steps(m, 1);
    m.irq.writeMask(1);
    m.irq.raise(0);
    steps(m, 1);
    expect(m.cpu.epc >>> 0).toBe(ORIGIN);
    expect(m.cpu.cause >>> 31).toBe(1);
    expect(m.cpu.pc >>> 0).toBe(0x80000080);
  });

  it('ignores stores while the cache is isolated', () => {
    const m = machineWith([asm.sw(2, 1, 0)]);
    m.cpu.sr = 0x10000;
    m.cpu.r[1] = DATA | 0;
    m.cpu.r[2] = 99;
    steps(m, 1);
    expect(m.bus.read32(DATA)).toBe(0);
  });
});
