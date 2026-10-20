import { describe, expect, it } from 'vitest';
import { Irq } from '../src/irq';
import { PlayStation } from '../src/playstation';
import { GAUSS } from '../src/spu/gauss';
import { CYCLES_PER_SAMPLE } from '../src/spu/spu';

const SPU = 0x1f801c00;

function spuMachine(): PlayStation {
  const m = new PlayStation();
  m.powerOn();
  const bus = m.bus;
  bus.write16(SPU + 0x1aa, 0xc000); // SPU on, unmuted
  bus.write16(SPU + 0x180, 0x3fff); // main volume
  bus.write16(SPU + 0x182, 0x3fff);
  return m;
}

/** Writes an ADPCM sample that loops: one block of a square-ish wave, with the loop start and end flags. */
function writeLoop(m: PlayStation, address: number): void {
  const bus = m.bus;
  bus.write16(SPU + 0x1a6, address >> 3);
  const block = [0x00, 0x07, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99];
  for (let i = 0; i < 16; i += 2) bus.write16(SPU + 0x1a8, block[i] | (block[i + 1] << 8));
}

describe('SPU', () => {
  it('plays a keyed-on voice through its envelope and stops it with key off', () => {
    const m = spuMachine();
    const bus = m.bus;
    writeLoop(m, 0x1000);
    bus.write16(SPU + 0x00, 0x3fff); // voice 0 volume
    bus.write16(SPU + 0x02, 0x3fff);
    bus.write16(SPU + 0x04, 0x1000); // 44.1 kHz
    bus.write16(SPU + 0x06, 0x1000 >> 3);
    bus.write16(SPU + 0x08, 0x00ff); // fast attack, sustain at full
    bus.write16(SPU + 0x0a, 0x0000);
    bus.write16(SPU + 0x188, 1); // key on
    m.run(CYCLES_PER_SAMPLE * 2000);
    m.spu.sync();
    const samples = m.spu.takeSamples();
    const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
    expect(peak).toBeGreaterThan(0.05);
    expect(bus.read16(SPU + 0x0c)).toBeGreaterThan(0x7000); // ADSR level reached the top
    expect(bus.read16(SPU + 0x19c) & 1).toBe(1); // ENDX: the loop end was reached
    bus.write16(SPU + 0x18c, 1); // key off: release
    m.run(CYCLES_PER_SAMPLE * 40000);
    expect(bus.read16(SPU + 0x0c)).toBe(0);
  });

  it('raises its interrupt when a voice reads the IRQ address', () => {
    const m = spuMachine();
    const bus = m.bus;
    writeLoop(m, 0x2000);
    bus.write16(SPU + 0x1a4, 0x2000 >> 3);
    bus.write16(SPU + 0x1aa, 0xc040); // IRQ enabled
    bus.write16(SPU + 0x04, 0x1000);
    bus.write16(SPU + 0x06, 0x2000 >> 3);
    bus.write16(SPU + 0x188, 1);
    m.run(CYCLES_PER_SAMPLE * 100);
    expect(m.irq.stat & (1 << Irq.Spu)).not.toBe(0);
    expect(bus.read16(SPU + 0x1ae) & 0x40).toBe(0x40);
  });

  it("interpolates with the hardware's Gaussian table, whose four weights sum to 0x7f7f..0x7f81", () => {
    for (let i = 0; i < 256; i++) {
      const sum = GAUSS[i] + GAUSS[0xff - i] + GAUSS[0x100 + i] + GAUSS[0x1ff - i];
      expect(sum).toBeGreaterThanOrEqual(0x7f7f);
      expect(sum).toBeLessThanOrEqual(0x7f81);
    }
    expect([GAUSS[0], GAUSS[0x100], GAUSS[0x1ff]]).toEqual([-1, 0x1307, 0x59b3]);
  });

  it('moves sound RAM through the transfer FIFO and DMA', () => {
    const m = spuMachine();
    const bus = m.bus;
    bus.write16(SPU + 0x1a6, 0x3000 >> 3);
    bus.write16(SPU + 0x1a8, 0xbeef);
    expect(m.spu.ram[0x3000] | (m.spu.ram[0x3001] << 8)).toBe(0xbeef);
    m.spu.transferAddress = 0x3000;
    expect(m.spu.dmaRead() & 0xffff).toBe(0xbeef);
  });
});
