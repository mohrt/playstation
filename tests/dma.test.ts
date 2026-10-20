import { describe, expect, it } from 'vitest';
import { Irq } from '../src/irq';
import { PlayStation } from '../src/playstation';

const DICR = 0x1f8010f4;

describe('DMA interrupts', () => {
  it('fire when the master flag goes up, not again while another channel keeps it up', () => {
    const m = new PlayStation();
    m.powerOn();
    const bus = m.bus;
    bus.write32(DICR, 0x00ff0000 | 0x800000); // all channels enabled, master enable
    // Clear an ordering table with channel 6, then one with channel 2's flag (GPU) left set.
    bus.write32(0x1f8010f0, 0x0fffffff);
    bus.write32(0x1f8010e0, 0x80010000);
    bus.write32(0x1f8010e4, 4);
    bus.write32(0x1f8010e8, 0x11000002);
    expect(m.irq.stat & (1 << Irq.Dma)).not.toBe(0);
    expect(bus.read32(DICR) >>> 24).toBe(0xc0);
    m.irq.writeStat(0);
    // Acknowledging channel 3 (whose flag isn't even set) leaves the master flag up: no new interrupt.
    bus.write32(DICR, (bus.read32(DICR) & 0xffffff) | 0x88000000);
    expect(m.irq.stat & (1 << Irq.Dma)).toBe(0);
    expect(bus.read32(DICR) >>> 31).toBe(1);
    // Acknowledging channel 6 drops it; the next transfer raises the interrupt again.
    bus.write32(DICR, (bus.read32(DICR) & 0xffffff) | 0x40000000);
    expect(bus.read32(DICR) >>> 31).toBe(0);
    bus.write32(0x1f8010e8, 0x11000002);
    expect(m.irq.stat & (1 << Irq.Dma)).not.toBe(0);
  });
});
