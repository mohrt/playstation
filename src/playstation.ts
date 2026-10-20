import { Bus, RAM_SIZE } from './bus';
import { CdRom } from './cdrom/cdrom';
import { Gte } from './cpu/gte';
import { Cpu } from './cpu/r3000a';
import type { Disc, DiscRegion } from './disc/disc';
import { Dma } from './dma';
import type { PsExe } from './exe';
import { Gpu } from './gpu/gpu';
import { Interrupts } from './irq';
import { Mdec } from './mdec';
import { CPU_HZ, Scheduler } from './scheduler';
import { Sio } from './sio/sio';
import { Spu } from './spu/spu';
import { Timers } from './timers';

/** Where the BIOS starts its shell; side-loaded programs replace it there. */
const SHELL_ENTRY = 0x80030000;

/** The whole console: CPU, GTE, memory, and the devices on the bus. */
export class PlayStation {
  readonly sched = new Scheduler();
  readonly irq = new Interrupts();
  readonly timers = new Timers(this.sched, this.irq);
  readonly gpu = new Gpu(this.sched, this.irq, this.timers);
  readonly sio = new Sio(this.sched, this.irq);
  readonly cdrom = new CdRom(this.sched, this.irq);
  readonly spu = new Spu(this.sched, this.irq);
  readonly mdec = new Mdec();
  readonly dma: Dma;
  readonly bus: Bus;
  readonly cpu: Cpu;
  hasBios = false;
  /** A program to start instead of the BIOS shell. */
  private exe: PsExe | null = null;
  /** Characters the running program printed through the BIOS (or the expansion port). */
  onTty: (char: number) => void = () => {};

  constructor() {
    const ram = new Int32Array(RAM_SIZE / 4);
    const { mdec, gpu, cdrom, spu } = this;
    this.dma = new Dma(ram, this.irq, this.sched, {
      mdecWrite: (word) => mdec.writeCommand(word),
      mdecRead: () => mdec.readData(),
      mdecAvailable: () => mdec.available(),
      mdecBusy: () => mdec.busy,
      gpuWrite: (word) => gpu.gp0(word),
      gpuRead: () => gpu.read(),
      cdromRead: () => cdrom.dmaRead(),
      spuWrite: (word) => spu.dmaWrite(word),
      spuRead: () => spu.dmaRead(),
    });
    this.bus = new Bus(this.sched, ram, {
      irq: this.irq,
      dma: this.dma,
      timers: this.timers,
      gpu,
      sio: this.sio,
      cdrom,
      spu,
      mdec,
    });
    this.cpu = new Cpu(this.bus, this.sched, new Gte());
    this.irq.onChange = (pending) => this.cpu.setInterruptLine(pending);
    this.mdec.onOutput = () => this.dma.retryMdecOut();
    this.spu.cdAudio = cdrom;
    this.bus.onTty = (char) => this.onTty(char);
    this.cpu.onBiosCall = (table, fn) => {
      if ((table === 0xa0 && fn === 0x3c) || (table === 0xb0 && fn === 0x3d)) this.onTty(this.cpu.r[4] & 0xff);
    };
    this.cpu.onHook = () => this.startExe();
  }

  get clockHz(): number {
    return CPU_HZ;
  }

  loadBios(image: Uint8Array): void {
    this.bus.loadBios(image);
    this.hasBios = true;
  }

  /** Switches the console on (or off and on): everything but the disc and memory cards is reset. */
  powerOn(): void {
    this.sched.reset();
    this.bus.reset();
    this.irq.reset();
    this.dma.reset();
    this.timers.reset();
    this.gpu.reset();
    this.sio.reset();
    this.cdrom.reset();
    this.spu.reset();
    this.mdec.reset();
    this.cpu.reset();
    this.cpu.hookPc = this.exe ? SHELL_ENTRY : -1;
  }

  insertDisc(disc: Disc | null, region: DiscRegion = 'ntsc-u'): void {
    this.cdrom.insertDisc(disc, region);
  }

  /** Runs `program` as soon as the BIOS has started (from the next power-on). */
  setExe(program: PsExe | null): void {
    this.exe = program;
    this.cpu.hookPc = program ? SHELL_ENTRY : -1;
  }

  private startExe(): void {
    const program = this.exe;
    this.cpu.hookPc = -1;
    if (!program) return;
    const ram = this.bus.ram8;
    const load = program.loadAddress & 0x1fffff;
    ram.set(program.text.subarray(0, Math.max(0, Math.min(program.text.length, ram.length - load))), load);
    if (program.bssSize) {
      const start = program.bssAddress & 0x1fffff;
      ram.fill(0, start, Math.min(ram.length, start + program.bssSize));
    }
    const r = this.cpu.r;
    r[28] = program.gp;
    if (program.stack) r[29] = r[30] = program.stack;
    r[4] = r[5] = 0;
    this.cpu.jump(program.pc);
  }

  /** Runs for `cycles` CPU cycles (devices' events included). */
  run(cycles: number): void {
    const end = this.sched.now + cycles;
    while (this.sched.now < end) {
      this.sched.beginSlice(end);
      this.cpu.run();
      this.sched.runDue();
    }
  }

  /** Runs until the next vertical blank (or two PAL frames' worth of time if there's none). */
  runFrame(): void {
    const frame = this.gpu.frameCount;
    const end = this.sched.now + Math.ceil(CPU_HZ / 25);
    while (this.gpu.frameCount === frame && this.sched.now < end) {
      this.sched.beginSlice(end);
      this.cpu.run();
      this.sched.runDue();
    }
  }
}
