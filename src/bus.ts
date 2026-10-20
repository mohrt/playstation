import type { CdRom } from './cdrom/cdrom';
import type { CpuBus } from './cpu/r3000a';
import type { Dma } from './dma';
import type { Gpu } from './gpu/gpu';
import type { Interrupts } from './irq';
import type { Mdec } from './mdec';
import type { Scheduler } from './scheduler';
import type { Sio } from './sio/sio';
import type { Spu } from './spu/spu';
import type { Timers } from './timers';

export const RAM_SIZE = 0x200000;
export const BIOS_SIZE = 0x80000;

// Read wait states in CPU cycles (beyond the instruction's own), for 8-, 16- and 32-bit accesses,
// as measured on a console. The BIOS, expansion and CD-ROM buses are 8 bits wide; the SPU's is 16.
const RAM_READ = 4;
const IO_READ = 2;
const BIOS_READ = [6, 12, 24];
const EXPANSION1_READ = [6, 12, 24];
const EXPANSION2_READ = [10, 25, 55];
const CDROM_READ = [7, 13, 25];
const SPU_READ = [17, 17, 37];
/** Fetching uncached (through KSEG1) from RAM or BIOS. */
const RAM_FETCH_UNCACHED = 4;
const BIOS_FETCH_UNCACHED = 24;

const W8 = 0;
const W16 = 1;
const W32 = 2;

export interface Devices {
  irq: Interrupts;
  dma: Dma;
  timers: Timers;
  gpu: Gpu;
  sio: Sio;
  cdrom: CdRom;
  spu: Spu;
  mdec: Mdec;
}

/**
 * The memory map: 2 MB of RAM (mirrored through the first 8 MB), the 1K
 * scratchpad, the 512K BIOS ROM, and the I/O ports. Addresses are physical
 * after dropping the top three bits (KUSEG, KSEG0 and KSEG1 all see the same).
 */
export class Bus implements CpuBus {
  readonly ram8: Uint8Array;
  readonly ram16: Uint16Array;
  readonly scratch = new Int32Array(0x100);
  private readonly scratch8 = new Uint8Array(this.scratch.buffer);
  private readonly scratch16 = new Uint16Array(this.scratch.buffer);
  readonly bios = new Int32Array(BIOS_SIZE / 4);
  private readonly bios8 = new Uint8Array(this.bios.buffer);
  private readonly bios16 = new Uint16Array(this.bios.buffer);
  readonly memControl = new Uint32Array(9);
  ramSize = 0x00000b88;
  cacheControl = 0;
  /** Characters written to the expansion port's serial TX register (some test programs print there). */
  onTty: (char: number) => void = () => {};

  /** `ram` is shared with the DMA controller. */
  constructor(
    private readonly sched: Scheduler,
    readonly ram: Int32Array,
    private readonly devices: Devices,
  ) {
    this.ram8 = new Uint8Array(ram.buffer);
    this.ram16 = new Uint16Array(ram.buffer);
  }

  loadBios(image: Uint8Array): void {
    if (image.length !== BIOS_SIZE) throw new Error('A PlayStation BIOS image is 512K.');
    this.bios8.set(image);
  }

  reset(): void {
    this.ram.fill(0);
    this.scratch.fill(0);
    this.memControl.fill(0);
    this.ramSize = 0x00000b88;
    this.cacheControl = 0;
  }

  fetch(address: number): number {
    const physical = address & 0x1fffffff;
    const uncached = address >>> 29 === 5;
    if (physical < 0x800000) {
      if (uncached) this.sched.now += RAM_FETCH_UNCACHED;
      return this.ram[(physical & 0x1ffffc) >> 2];
    }
    if (physical >= 0x1fc00000 && physical < 0x1fc80000) {
      if (uncached) this.sched.now += BIOS_FETCH_UNCACHED;
      return this.bios[(physical & 0x7fffc) >> 2];
    }
    return this.read32(address);
  }

  read32(address: number): number {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) {
      this.sched.now += RAM_READ;
      return this.ram[(physical & 0x1ffffc) >> 2];
    }
    if ((physical & 0xfffffc00) === 0x1f800000) return this.scratch[(physical & 0x3fc) >> 2];
    if (physical >= 0x1fc00000 && physical < 0x1fc80000) {
      this.sched.now += BIOS_READ[W32];
      return this.bios[(physical & 0x7fffc) >> 2];
    }
    if (physical >= 0x1f801000 && physical < 0x1f802000) return this.ioRead(physical, W32);
    if (address >>> 0 === 0xfffe0130) return this.cacheControl;
    return this.unmappedRead(physical, W32);
  }

  read16(address: number): number {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) {
      this.sched.now += RAM_READ;
      return this.ram16[(physical & 0x1ffffe) >> 1];
    }
    if ((physical & 0xfffffc00) === 0x1f800000) return this.scratch16[(physical & 0x3fe) >> 1];
    if (physical >= 0x1fc00000 && physical < 0x1fc80000) {
      this.sched.now += BIOS_READ[W16];
      return this.bios16[(physical & 0x7fffe) >> 1];
    }
    if (physical >= 0x1f801000 && physical < 0x1f802000) return this.ioRead(physical, W16) & 0xffff;
    return this.unmappedRead(physical, W16) & 0xffff;
  }

  read8(address: number): number {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) {
      this.sched.now += RAM_READ;
      return this.ram8[physical & 0x1fffff];
    }
    if ((physical & 0xfffffc00) === 0x1f800000) return this.scratch8[physical & 0x3ff];
    if (physical >= 0x1fc00000 && physical < 0x1fc80000) {
      this.sched.now += BIOS_READ[W8];
      return this.bios8[physical & 0x7ffff];
    }
    if (physical >= 0x1f801000 && physical < 0x1f802000) return this.ioRead(physical, W8) & 0xff;
    return this.unmappedRead(physical, W8) & 0xff;
  }

  /** The expansion regions read as all ones (nothing is plugged into the parallel port). */
  private unmappedRead(physical: number, width: number): number {
    if (physical >= 0x1f000000 && physical < 0x1f800000) {
      this.sched.now += EXPANSION1_READ[width];
      return -1;
    }
    if (physical >= 0x1f802000 && physical < 0x1f804000) {
      this.sched.now += EXPANSION2_READ[width];
      return -1;
    }
    return 0;
  }

  /** Narrow stores carry the whole register, shifted onto the addressed byte lane; RAM keeps only the lane. */
  write32(address: number, value: number): void {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) {
      this.ram[(physical & 0x1ffffc) >> 2] = value;
      return;
    }
    if ((physical & 0xfffffc00) === 0x1f800000) {
      this.scratch[(physical & 0x3fc) >> 2] = value;
      return;
    }
    if (physical >= 0x1f801000 && physical < 0x1f802000) {
      this.ioWrite(physical, value, W32);
      return;
    }
    if (address >>> 0 === 0xfffe0130) this.cacheControl = value >>> 0;
  }

  write16(address: number, value: number): void {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) {
      this.ram16[(physical & 0x1ffffe) >> 1] = value;
      return;
    }
    if ((physical & 0xfffffc00) === 0x1f800000) {
      this.scratch16[(physical & 0x3fe) >> 1] = value;
      return;
    }
    if (physical >= 0x1f801000 && physical < 0x1f802000) this.ioWrite(physical, value, W16);
  }

  write8(address: number, value: number): void {
    const physical = address & 0x1fffffff;
    if (physical < 0x800000) {
      this.ram8[physical & 0x1fffff] = value;
      return;
    }
    if ((physical & 0xfffffc00) === 0x1f800000) {
      this.scratch8[physical & 0x3ff] = value;
      return;
    }
    if (physical >= 0x1f801000 && physical < 0x1f802000) this.ioWrite(physical, value, W8);
    else if (physical === 0x1f802023 || physical === 0x1f802080) this.onTty(value & 0xff);
  }

  // --- I/O ----------------------------------------------------------------------

  private ioRead(physical: number, width: number): number {
    const d = this.devices;
    if (physical >= 0x1f801c00) {
      this.sched.now += SPU_READ[width];
      const offset = (physical - 0x1f801c00) & ~1;
      if (width === W32) return d.spu.read16(offset) | (d.spu.read16(offset + 2) << 16);
      return d.spu.read16(offset) >> ((physical & 1) * 8);
    }
    if (physical >= 0x1f801800 && physical < 0x1f801804) {
      this.sched.now += CDROM_READ[width];
      const value = d.cdrom.read(physical & 3);
      return value | (value << 8) | (value << 16) | (value << 24);
    }
    this.sched.now += IO_READ;
    if (physical >= 0x1f801040 && physical < 0x1f801050) {
      // A word read covers two 16-bit registers, except at the data FIFO.
      const offset = physical & 0xf;
      if (width !== W32 || offset === 0) return d.sio.read(offset);
      return d.sio.read(offset) | (d.sio.read(offset + 2) << 16);
    }
    return this.readRegister(physical & ~3) >> ((physical & 3) * 8);
  }

  /** A 32-bit register (by its aligned address). */
  private readRegister(address: number): number {
    const d = this.devices;
    if (address < 0x1f801024) return this.memControl[(address - 0x1f801000) >> 2];
    if (address === 0x1f801060) return this.ramSize;
    if (address === 0x1f801070) return d.irq.stat;
    if (address === 0x1f801074) return d.irq.mask;
    if (address >= 0x1f801080 && address < 0x1f801100) return d.dma.read(address - 0x1f801080) | 0;
    if (address >= 0x1f801100 && address < 0x1f801130) return d.timers.read(address - 0x1f801100);
    if (address === 0x1f801810) return d.gpu.read() | 0;
    if (address === 0x1f801814) return d.gpu.readStatus() | 0;
    if (address === 0x1f801820) return d.mdec.readData() | 0;
    if (address === 0x1f801824) return d.mdec.readStatus() | 0;
    return 0;
  }

  private ioWrite(physical: number, value: number, width: number): void {
    const d = this.devices;
    if (physical >= 0x1f801c00) {
      const offset = (physical - 0x1f801c00) & ~1;
      d.spu.write16(offset, value & 0xffff);
      if (width === W32) d.spu.write16(offset + 2, value >>> 16);
      return;
    }
    if (physical >= 0x1f801800 && physical < 0x1f801804) {
      d.cdrom.write(physical & 3, value & 0xff);
      return;
    }
    if (physical >= 0x1f801040 && physical < 0x1f801050) {
      const offset = physical & 0xf;
      d.sio.write(offset, value & 0xffff);
      if (width === W32 && offset !== 0) d.sio.write(offset + 2, value >>> 16);
      return;
    }
    this.writeRegister(physical & ~3, value << ((physical & 3) * 8));
  }

  private writeRegister(address: number, value: number): void {
    const d = this.devices;
    value |= 0;
    if (address < 0x1f801024) {
      this.memControl[(address - 0x1f801000) >> 2] = value;
      return;
    }
    if (address === 0x1f801060) {
      this.ramSize = value >>> 0;
      return;
    }
    if (address === 0x1f801070) {
      d.irq.writeStat(value);
      return;
    }
    if (address === 0x1f801074) {
      d.irq.writeMask(value);
      return;
    }
    if (address >= 0x1f801080 && address < 0x1f801100) {
      d.dma.write(address - 0x1f801080, value);
      return;
    }
    if (address >= 0x1f801100 && address < 0x1f801130) {
      d.timers.write(address - 0x1f801100, value);
      return;
    }
    switch (address) {
      case 0x1f801810:
        d.gpu.gp0(value);
        return;
      case 0x1f801814:
        d.gpu.gp1(value);
        return;
      case 0x1f801820:
        d.mdec.writeCommand(value);
        return;
      case 0x1f801824:
        d.mdec.writeControl(value);
        return;
    }
  }
}
