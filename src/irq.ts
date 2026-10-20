/** Interrupt lines of the interrupt controller (bits of I_STAT and I_MASK). */
export const Irq = {
  VBlank: 0,
  Gpu: 1,
  CdRom: 2,
  Dma: 3,
  Timer0: 4,
  Timer1: 5,
  Timer2: 6,
  Sio0: 7,
  Sio1: 8,
  Spu: 9,
  Lightpen: 10,
} as const;

/** I_STAT and I_MASK: devices set bits of I_STAT; the CPU sees an interrupt while any unmasked bit is set. */
export class Interrupts {
  stat = 0;
  mask = 0;
  /** Tells the CPU whether its interrupt line (COP0 cause bit 10) is up. */
  onChange: (pending: boolean) => void = () => {};

  reset(): void {
    this.stat = this.mask = 0;
    this.update();
  }

  raise(line: number): void {
    this.stat |= 1 << line;
    this.update();
  }

  /** Writing I_STAT acknowledges: bits written as 0 are cleared. */
  writeStat(value: number): void {
    this.stat &= value & 0x7ff;
    this.update();
  }

  writeMask(value: number): void {
    this.mask = value & 0x7ff;
    this.update();
  }

  private update(): void {
    this.onChange((this.stat & this.mask) !== 0);
  }
}
