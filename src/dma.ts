import { Irq, type Interrupts } from './irq';
import type { Scheduler } from './scheduler';

export const DmaChannel = { MdecIn: 0, MdecOut: 1, Gpu: 2, CdRom: 3, Spu: 4, Pio: 5, Otc: 6 } as const;

/** The devices DMA moves words to and from. */
export interface DmaDevices {
  mdecWrite(word: number): void;
  mdecRead(): number;
  /** Words of decoded output waiting in the MDEC. */
  mdecAvailable(): number;
  /** The MDEC is still waiting for input to decode. */
  mdecBusy(): boolean;
  gpuWrite(word: number): void;
  gpuRead(): number;
  cdromRead(): number;
  spuWrite(word: number): void;
  spuRead(): number;
}

const CHCR_FROM_RAM = 1 << 0;
const CHCR_BACKWARD = 1 << 1;
const CHCR_BUSY = 1 << 24;
const CHCR_TRIGGER = 1 << 28;
const RAM_MASK = 0x1ffffc;
/** A GPU ordering table longer than this is taken to be a loop. */
const MAX_LIST_NODES = 0x40000;

/**
 * The DMA controller: seven channels between RAM and devices. Transfers run
 * to completion as soon as they start (the CPU is held for their length),
 * except MDEC output, which waits until the MDEC has decoded enough words.
 */
export class Dma {
  readonly madr = new Uint32Array(7);
  readonly bcr = new Uint32Array(7);
  readonly chcr = new Uint32Array(7);
  dpcr = 0x07654321;
  dicr = 0;

  constructor(
    private readonly memory: Int32Array,
    private readonly irq: Interrupts,
    private readonly sched: Scheduler,
    private readonly devices: DmaDevices,
  ) {}

  reset(): void {
    this.madr.fill(0);
    this.bcr.fill(0);
    this.chcr.fill(0);
    this.chcr[DmaChannel.Otc] = CHCR_BACKWARD;
    this.dpcr = 0x07654321;
    this.dicr = 0;
  }

  read(offset: number): number {
    if (offset >= 0x70) return offset === 0x70 ? this.dpcr : offset === 0x74 ? this.dicr : 0;
    const ch = offset >> 4;
    switch (offset & 0xc) {
      case 0x0:
        return this.madr[ch];
      case 0x4:
        return this.bcr[ch];
      case 0x8:
        return this.chcr[ch];
      default:
        return 0;
    }
  }

  write(offset: number, value: number): void {
    value >>>= 0;
    if (offset >= 0x70) {
      if (offset === 0x70) {
        this.dpcr = value;
        for (let ch = 0; ch < 7; ch++) this.tryStart(ch);
      } else if (offset === 0x74) {
        this.writeDicr(value);
      }
      return;
    }
    const ch = offset >> 4;
    switch (offset & 0xc) {
      case 0x0:
        this.madr[ch] = value & 0xffffff;
        return;
      case 0x4:
        this.bcr[ch] = value;
        return;
      case 0x8:
        this.chcr[ch] = ch === DmaChannel.Otc ? (value & 0x51000000) | CHCR_BACKWARD : value & 0x71770703;
        this.tryStart(ch);
        return;
    }
  }

  private writeDicr(value: number): void {
    const acknowledged = value & 0x7f000000;
    // The master flag (bit 31) is kept, so the interrupt only fires when it newly goes up.
    this.dicr = (this.dicr & 0xff000000 & ~acknowledged) | (value & 0x00ff803f);
    this.updateMasterFlag();
  }

  private updateMasterFlag(): void {
    const enabled = (this.dicr >>> 16) & 0x7f;
    const flags = (this.dicr >>> 24) & 0x7f;
    const master = (this.dicr & 0x8000) !== 0 || ((this.dicr & 0x800000) !== 0 && (enabled & flags) !== 0);
    const was = (this.dicr & 0x80000000) !== 0;
    this.dicr = (master ? this.dicr | 0x80000000 : this.dicr & 0x7fffffff) >>> 0;
    if (master && !was) this.irq.raise(Irq.Dma);
  }

  private enabled(ch: number): boolean {
    return (this.dpcr & (8 << (ch * 4))) !== 0;
  }

  private tryStart(ch: number): void {
    const chcr = this.chcr[ch];
    if (!(chcr & CHCR_BUSY) || !this.enabled(ch)) return;
    const sync = (chcr >> 9) & 3;
    if (sync === 0 && !(chcr & CHCR_TRIGGER)) return;
    this.chcr[ch] &= ~CHCR_TRIGGER;
    if (ch === DmaChannel.MdecOut && sync === 1) {
      this.mdecOutTransferred = 0;
      this.mdecOutBlocks();
      return;
    }
    if (sync === 2) this.linkedList(ch);
    else this.block(ch, sync);
    this.finish(ch);
  }

  private mdecOutTransferred = 0;

  /**
   * MDEC output moves a block at a time as the MDEC decodes it. Once the MDEC
   * has nothing more to decode and its output is drained, the transfer ends
   * even if blocks were left.
   */
  private mdecOutBlocks(): void {
    const ch = DmaChannel.MdecOut;
    const d = this.devices;
    const size = this.bcr[ch] & 0xffff || 0x10000;
    let blocks = this.bcr[ch] >>> 16 || 0x10000;
    let address = this.madr[ch];
    while (blocks > 0 && d.mdecAvailable() > 0 && (d.mdecAvailable() >= size || !d.mdecBusy())) {
      const words = Math.min(size, d.mdecAvailable());
      for (let i = 0; i < words; i++, address += 4) this.memory[(address & RAM_MASK) >> 2] = d.mdecRead();
      this.mdecOutTransferred += words;
      this.sched.now += words;
      blocks--;
    }
    this.madr[ch] = address & 0xffffff;
    this.bcr[ch] = ((this.bcr[ch] & 0xffff) | ((blocks & 0xffff) << 16)) >>> 0;
    const drained = this.mdecOutTransferred > 0 && !d.mdecBusy() && d.mdecAvailable() === 0;
    if (blocks === 0 || drained) this.finish(ch);
  }

  /** The MDEC calls this when it has output, for a transfer that was waiting. */
  retryMdecOut(): void {
    const chcr = this.chcr[DmaChannel.MdecOut];
    if (chcr & CHCR_BUSY && this.enabled(DmaChannel.MdecOut) && ((chcr >> 9) & 3) === 1) this.mdecOutBlocks();
  }

  private blockWords(ch: number, sync: number): number {
    const bcr = this.bcr[ch];
    if (sync === 0) return bcr & 0xffff || 0x10000;
    return (bcr & 0xffff || 0x10000) * (bcr >>> 16 || 0x10000);
  }

  private block(ch: number, sync: number): void {
    const words = this.blockWords(ch, sync);
    const chcr = this.chcr[ch];
    const step = chcr & CHCR_BACKWARD ? -4 : 4;
    let address = this.madr[ch];
    const ram = this.memory;
    const d = this.devices;
    if (ch === DmaChannel.Otc) {
      // Clears an ordering table: each entry points to the one before; the last is the end marker.
      for (let i = 0; i < words; i++) {
        ram[(address & RAM_MASK) >> 2] = i === words - 1 ? 0x00ffffff : (address - 4) & 0x1fffff;
        address -= 4;
      }
    } else if (chcr & CHCR_FROM_RAM) {
      for (let i = 0; i < words; i++, address += step) {
        const word = ram[(address & RAM_MASK) >> 2];
        if (ch === DmaChannel.Gpu) d.gpuWrite(word);
        else if (ch === DmaChannel.MdecIn) d.mdecWrite(word);
        else if (ch === DmaChannel.Spu) d.spuWrite(word);
      }
    } else {
      for (let i = 0; i < words; i++, address += step) {
        let word = 0;
        if (ch === DmaChannel.Gpu) word = d.gpuRead();
        else if (ch === DmaChannel.CdRom) word = d.cdromRead();
        else if (ch === DmaChannel.MdecOut) word = d.mdecRead();
        else if (ch === DmaChannel.Spu) word = d.spuRead();
        else word = ch === DmaChannel.Pio ? -1 : 0;
        ram[(address & RAM_MASK) >> 2] = word;
      }
    }
    if (sync === 1) {
      this.madr[ch] = address & 0xffffff;
      this.bcr[ch] &= 0xffff;
    }
    this.sched.now += words;
  }

  private linkedList(ch: number): void {
    if (ch !== DmaChannel.Gpu) return;
    const ram = this.memory;
    let address = this.madr[ch] & RAM_MASK;
    let words = 0;
    for (let nodes = 0; nodes < MAX_LIST_NODES; nodes++) {
      const header = ram[address >> 2];
      const count = header >>> 24;
      for (let i = 1; i <= count; i++) this.devices.gpuWrite(ram[((address + i * 4) & RAM_MASK) >> 2]);
      words += count + 1;
      if (header & 0x800000) break;
      address = header & RAM_MASK;
    }
    this.madr[ch] = 0x00ffffff;
    this.sched.now += words;
  }

  private finish(ch: number): void {
    this.chcr[ch] &= ~CHCR_BUSY;
    if (this.dicr & (1 << (16 + ch))) this.dicr |= 1 << (24 + ch);
    this.updateMasterFlag();
  }
}
