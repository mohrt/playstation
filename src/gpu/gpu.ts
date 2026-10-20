import { Irq, type Interrupts } from '../irq';
import { TimedEvent, type Scheduler } from '../scheduler';
import type { Timers } from '../timers';
import { DRAW_RAW, DRAW_SEMI, DRAW_SHADED, DRAW_TEXTURED, Rasterizer, VRAM_HEIGHT, VRAM_WIDTH, vertex, type Vertex } from './raster';

export type VideoStandard = 'ntsc' | 'pal';

/** GPU clocks per scanline and scanlines per frame. */
const TIMING = {
  ntsc: { clocksPerLine: 3413, lines: 263, visibleLines: 240 },
  pal: { clocksPerLine: 3406, lines: 314, visibleLines: 288 },
};
/** The GPU's clock is 11/7 of the CPU's. */
const GPU_TO_CPU = 7 / 11;
/** Horizontal resolutions (GP1(08h) bits 0-1, or 368 with bit 6) and their dot clock dividers. */
const HRES = [
  { width: 256, divider: 10 },
  { width: 320, divider: 8 },
  { width: 512, divider: 5 },
  { width: 640, divider: 4 },
];
const HRES_368 = { width: 368, divider: 7 };

export const MAX_FRAME_WIDTH = 640;
export const MAX_FRAME_HEIGHT = 576;

const s11 = (value: number) => (value << 21) >> 21;

/** Words in each GP0 command (polylines are open-ended and handled separately). */
function commandLength(command: number): number {
  if (command >= 0x20 && command < 0x40) {
    const vertices = command & 0x08 ? 4 : 3;
    const perVertex = 1 + (command & 0x04 ? 1 : 0) + (command & 0x10 ? 1 : 0);
    return vertices * perVertex + (command & 0x10 ? 0 : 1);
  }
  if (command >= 0x40 && command < 0x60) return command & 0x10 ? 4 : 3;
  if (command >= 0x60 && command < 0x80) return 2 + (command & 0x04 ? 1 : 0) + ((command & 0x18) === 0 ? 1 : 0);
  if (command >= 0x80 && command < 0xa0) return 4;
  if (command >= 0xa0 && command < 0xe0) return 3;
  if (command === 0x02) return 3;
  return 1;
}

/**
 * The GPU: takes drawing commands on GP0 and display settings on GP1, draws
 * into its 1 MB of VRAM, and scans part of VRAM out to the TV. It also keeps
 * the video timing, which drives the vertical blank interrupt and timers 0 and 1.
 */
export class Gpu {
  readonly vram = new Uint16Array(VRAM_WIDTH * VRAM_HEIGHT);
  private readonly raster = new Rasterizer(this.vram);

  // GP0 drawing state (GPUSTAT bits 0-15, E2-E6).
  texpage = 0;
  textureDisable = false;
  rectFlipX = false;
  rectFlipY = false;
  windowMaskX = 0;
  windowMaskY = 0;
  windowOffsetX = 0;
  windowOffsetY = 0;
  drawLeft = 0;
  drawTop = 0;
  drawRight = 0;
  drawBottom = 0;
  offsetX = 0;
  offsetY = 0;
  setMask = false;
  checkMask = false;

  // GP1 display state.
  displayDisabled = true;
  dmaDirection = 0;
  displayX = 0;
  displayY = 0;
  hRangeStart = 0x200;
  hRangeEnd = 0xc00;
  vRangeStart = 0x10;
  vRangeEnd = 0x100;
  displayMode = 0;
  allowTextureDisable = false;
  irqPending = false;
  gpuReadLatch = 0;

  // Command FIFO.
  private readonly command = new Uint32Array(16);
  private commandWords = 0;
  private commandNeeded = 0;
  private polyline = false;
  // CPU-to-VRAM and VRAM-to-CPU transfers.
  private uploadRemaining = 0;
  private downloadRemaining = 0;
  private transferX = 0;
  private transferY = 0;
  private transferWidth = 0;
  private transferHeight = 0;
  private transferIndex = 0;

  // Video timing.
  line = 0;
  field = 0;
  private lineFraction = 0;
  inVblank = false;
  frameCount = 0;
  private readonly lineEvent: TimedEvent;

  /** The picture shown at the last vertical blank, as RGBA pixels. */
  readonly framebuffer = new Uint32Array(MAX_FRAME_WIDTH * MAX_FRAME_HEIGHT);
  frameWidth = 320;
  frameHeight = 240;
  /** Called at each vertical blank with the new picture. */
  onFrame: () => void = () => {};

  private readonly vertices: Vertex[] = [vertex(), vertex(), vertex(), vertex()];

  constructor(
    private readonly sched: Scheduler,
    private readonly irq: Interrupts,
    private readonly timers: Timers,
  ) {
    this.lineEvent = sched.add(new TimedEvent('gpu-line', () => this.endOfLine()));
  }

  reset(): void {
    this.vram.fill(0);
    this.resetGpu();
    this.line = this.field = this.lineFraction = 0;
    this.inVblank = false;
    this.frameCount = 0;
    this.sched.schedule(this.lineEvent, this.cyclesPerLine());
    this.updateDotClock();
  }

  private resetGpu(): void {
    this.texpage = 0;
    this.textureDisable = this.rectFlipX = this.rectFlipY = false;
    this.windowMaskX = this.windowMaskY = this.windowOffsetX = this.windowOffsetY = 0;
    this.drawLeft = this.drawTop = this.drawRight = this.drawBottom = 0;
    this.offsetX = this.offsetY = 0;
    this.setMask = this.checkMask = false;
    this.displayDisabled = true;
    this.dmaDirection = 0;
    this.displayX = this.displayY = 0;
    this.hRangeStart = 0x200;
    this.hRangeEnd = 0xc00;
    this.vRangeStart = 0x10;
    this.vRangeEnd = 0x100;
    this.displayMode = 0;
    this.irqPending = false;
    this.resetCommandBuffer();
    this.updateDotClock();
  }

  private resetCommandBuffer(): void {
    this.commandWords = this.commandNeeded = 0;
    this.polyline = false;
    this.uploadRemaining = this.downloadRemaining = 0;
  }

  /** PAL or NTSC timing, as set by GP1(08h) bit 3 (the BIOS sets it for the console's region). */
  get standard(): VideoStandard {
    return this.displayMode & 0x08 ? 'pal' : 'ntsc';
  }

  // --- Video timing -----------------------------------------------------------------

  private cyclesPerLine(): number {
    return TIMING[this.standard].clocksPerLine * GPU_TO_CPU;
  }

  private get hres(): { width: number; divider: number } {
    return this.displayMode & 0x40 ? HRES_368 : HRES[this.displayMode & 3];
  }

  private get interlaced(): boolean {
    return (this.displayMode & 0x20) !== 0;
  }

  private updateDotClock(): void {
    this.timers.dotCycles = this.hres.divider * GPU_TO_CPU;
  }

  private endOfLine(): void {
    const timing = TIMING[this.standard];
    const exact = this.cyclesPerLine() + this.lineFraction;
    const whole = Math.floor(exact);
    this.lineFraction = exact - whole;
    this.sched.schedule(this.lineEvent, whole);

    this.timers.hblank();
    this.line++;
    if (this.line === timing.visibleLines) {
      this.inVblank = true;
      this.irq.raise(Irq.VBlank);
      this.timers.vblank(true);
      this.frameCount++;
      this.scanOut();
      this.onFrame();
    } else if (this.line >= timing.lines) {
      this.line = 0;
      this.inVblank = false;
      this.timers.vblank(false);
      if (this.interlaced) this.field ^= 1;
      else this.field = 0;
    }
  }

  // --- Registers --------------------------------------------------------------------

  readStatus(): number {
    let status = this.texpage & 0x7ff;
    if (this.setMask) status |= 1 << 11;
    if (this.checkMask) status |= 1 << 12;
    // Bit 13 is the field being shown (always 1 when not interlaced); bit 31 the one being drawn.
    if (!this.interlaced || !this.field) status |= 1 << 13;
    if (this.displayMode & 0x80) status |= 1 << 14;
    if (this.textureDisable) status |= 1 << 15;
    status |= ((this.displayMode >> 6) & 1) << 16;
    status |= (this.displayMode & 3) << 17;
    status |= ((this.displayMode >> 2) & 1) << 19;
    status |= ((this.displayMode >> 3) & 7) << 20;
    if (this.displayDisabled) status |= 1 << 23;
    if (this.irqPending) status |= 1 << 24;
    const readyToSend = this.downloadRemaining > 0;
    status |= 1 << 26; // ready for a command
    if (readyToSend) status |= 1 << 27;
    status |= 1 << 28; // ready for a DMA block
    switch (this.dmaDirection) {
      case 1:
        status |= 1 << 25;
        break;
      case 2:
        status |= 1 << 25;
        break;
      case 3:
        if (readyToSend) status |= 1 << 25;
        break;
    }
    status |= this.dmaDirection << 29;
    if (!this.inVblank) {
      const odd = this.interlaced && this.displayMode & 0x04 ? this.field : this.line & 1;
      if (odd) status |= 1 << 31;
    }
    return status >>> 0;
  }

  read(): number {
    if (this.downloadRemaining > 0) {
      const low = this.downloadPixel();
      const high = this.downloadRemaining > 0 ? this.downloadPixel() : 0;
      this.gpuReadLatch = (low | (high << 16)) >>> 0;
    }
    return this.gpuReadLatch;
  }

  private downloadPixel(): number {
    const x = (this.transferX + (this.transferIndex % this.transferWidth)) & 1023;
    const y = (this.transferY + Math.floor(this.transferIndex / this.transferWidth)) & 511;
    this.transferIndex++;
    this.downloadRemaining--;
    return this.vram[y * VRAM_WIDTH + x];
  }

  gp1(value: number): void {
    value >>>= 0;
    const command = (value >>> 24) & 0x3f;
    switch (command) {
      case 0x00:
        this.resetGpu();
        break;
      case 0x01:
        this.resetCommandBuffer();
        break;
      case 0x02:
        this.irqPending = false;
        break;
      case 0x03:
        this.displayDisabled = (value & 1) !== 0;
        break;
      case 0x04:
        this.dmaDirection = value & 3;
        break;
      case 0x05:
        this.displayX = value & 0x3fe;
        this.displayY = (value >> 10) & 0x1ff;
        break;
      case 0x06:
        this.hRangeStart = value & 0xfff;
        this.hRangeEnd = (value >> 12) & 0xfff;
        break;
      case 0x07:
        this.vRangeStart = value & 0x3ff;
        this.vRangeEnd = (value >> 10) & 0x3ff;
        break;
      case 0x08:
        this.displayMode = value & 0xff;
        this.updateDotClock();
        break;
      case 0x09:
        this.allowTextureDisable = (value & 1) !== 0;
        break;
      default:
        if (command >= 0x10 && command < 0x20) this.info(value & 0xf);
    }
  }

  /** GP1(10h): puts drawing settings (or the GPU version) on GPUREAD. */
  private info(index: number): void {
    switch (index & 7) {
      case 2:
        this.gpuReadLatch = (this.windowMaskX >> 3) | ((this.windowMaskY >> 3) << 5) | ((this.windowOffsetX >> 3) << 10) | ((this.windowOffsetY >> 3) << 15);
        break;
      case 3:
        this.gpuReadLatch = this.drawLeft | (this.drawTop << 10);
        break;
      case 4:
        this.gpuReadLatch = this.drawRight | (this.drawBottom << 10);
        break;
      case 5:
        this.gpuReadLatch = (this.offsetX & 0x7ff) | ((this.offsetY & 0x7ff) << 11);
        break;
      case 7:
        this.gpuReadLatch = 2;
        break;
    }
  }

  gp0(value: number): void {
    value >>>= 0;
    if (this.uploadRemaining > 0) {
      this.uploadPixel(value & 0xffff);
      if (this.uploadRemaining > 0) this.uploadPixel(value >>> 16);
      return;
    }
    if (this.commandWords === 0) {
      const command = value >>> 24;
      this.commandNeeded = commandLength(command);
      this.polyline = command >= 0x40 && command < 0x60 && (command & 0x08) !== 0;
    }
    if (this.polyline) {
      this.polylineWord(value);
      return;
    }
    this.command[this.commandWords++] = value;
    if (this.commandWords >= this.commandNeeded) {
      this.commandWords = 0;
      this.execute();
    }
  }

  private uploadPixel(pixel: number): void {
    const x = (this.transferX + (this.transferIndex % this.transferWidth)) & 1023;
    const y = (this.transferY + Math.floor(this.transferIndex / this.transferWidth)) & 511;
    this.transferIndex++;
    this.uploadRemaining--;
    const index = y * VRAM_WIDTH + x;
    if (this.checkMask && this.vram[index] & 0x8000) return;
    this.vram[index] = pixel | (this.setMask ? 0x8000 : 0);
  }

  // --- Drawing ----------------------------------------------------------------------

  private prepareRaster(): void {
    const r = this.raster;
    r.left = this.drawLeft;
    r.top = this.drawTop;
    r.right = Math.min(this.drawRight, VRAM_WIDTH - 1);
    r.bottom = Math.min(this.drawBottom, VRAM_HEIGHT - 1);
    r.dither = (this.texpage & 0x200) !== 0;
    r.maskOr = this.setMask ? 0x8000 : 0;
    r.checkMask = this.checkMask;
    r.semiMode = (this.texpage >> 5) & 3;
    r.pageX = (this.texpage & 0xf) * 64;
    r.pageY = ((this.texpage >> 4) & 1) * 256;
    r.depth = Math.min(2, (this.texpage >> 7) & 3);
    r.windowMaskX = this.windowMaskX;
    r.windowMaskY = this.windowMaskY;
    r.windowOffsetX = this.windowOffsetX & this.windowMaskX;
    r.windowOffsetY = this.windowOffsetY & this.windowMaskY;
  }

  private setVertexColor(v: Vertex, word: number): void {
    v.r = word & 0xff;
    v.g = (word >> 8) & 0xff;
    v.b = (word >> 16) & 0xff;
  }

  private setVertexPosition(v: Vertex, word: number): void {
    v.x = s11(word) + this.offsetX;
    v.y = s11(word >> 16) + this.offsetY;
  }

  /** A textured polygon's texture page attribute: sets the page, blending and depth (not dithering). */
  private setTexpage(value: number): void {
    this.texpage = (this.texpage & 0x600) | (value & 0x1ff);
    this.textureDisable = this.allowTextureDisable && (value & 0x800) !== 0;
  }

  private execute(): void {
    const words = this.command;
    const op = words[0] >>> 24;
    if (op >= 0x20 && op < 0x40) return this.polygon(op);
    if (op >= 0x40 && op < 0x60) return this.lineCommand(op);
    if (op >= 0x60 && op < 0x80) return this.rectangle(op);
    if (op >= 0x80 && op < 0xa0) return this.copyVram();
    if (op >= 0xa0 && op < 0xc0) return this.startTransfer(true);
    if (op >= 0xc0 && op < 0xe0) return this.startTransfer(false);
    const value = words[0];
    switch (op) {
      case 0x02:
        this.fill();
        return;
      case 0x1f:
        this.irqPending = true;
        this.irq.raise(Irq.Gpu);
        return;
      case 0xe1:
        this.texpage = value & 0x7ff;
        this.textureDisable = this.allowTextureDisable && (value & 0x800) !== 0;
        this.rectFlipX = (value & 0x1000) !== 0;
        this.rectFlipY = (value & 0x2000) !== 0;
        return;
      case 0xe2:
        this.windowMaskX = (value & 0x1f) * 8;
        this.windowMaskY = ((value >> 5) & 0x1f) * 8;
        this.windowOffsetX = ((value >> 10) & 0x1f) * 8;
        this.windowOffsetY = ((value >> 15) & 0x1f) * 8;
        return;
      case 0xe3:
        this.drawLeft = value & 0x3ff;
        this.drawTop = (value >> 10) & 0x3ff;
        return;
      case 0xe4:
        this.drawRight = value & 0x3ff;
        this.drawBottom = (value >> 10) & 0x3ff;
        return;
      case 0xe5:
        this.offsetX = s11(value);
        this.offsetY = s11(value >> 11);
        return;
      case 0xe6:
        this.setMask = (value & 1) !== 0;
        this.checkMask = (value & 2) !== 0;
        return;
    }
  }

  private polygon(op: number): void {
    const words = this.command;
    const shaded = (op & 0x10) !== 0;
    const textured = (op & 0x04) !== 0;
    const count = op & 0x08 ? 4 : 3;
    let flags = (shaded ? DRAW_SHADED : 0) | (op & 0x02 ? DRAW_SEMI : 0);
    if (textured) flags |= DRAW_TEXTURED | (op & 0x01 ? DRAW_RAW : 0);
    let w = 0;
    let color = words[w++];
    let clut = 0;
    for (let i = 0; i < count; i++) {
      const v = this.vertices[i];
      if (shaded && i > 0) color = words[w++];
      this.setVertexColor(v, color);
      this.setVertexPosition(v, words[w++]);
      if (textured) {
        const uv = words[w++];
        v.u = uv & 0xff;
        v.v = (uv >> 8) & 0xff;
        if (i === 0) clut = uv >>> 16;
        if (i === 1) this.setTexpage(uv >>> 16);
      }
    }
    this.prepareRaster();
    if (textured) {
      this.raster.clutX = (clut & 0x3f) * 16;
      this.raster.clutY = (clut >> 6) & 0x1ff;
    }
    const [a, b, c, d] = this.vertices;
    if (this.fitsLimits(a, b, c)) this.raster.triangle(a, b, c, flags);
    if (count === 4 && this.fitsLimits(b, c, d)) this.raster.triangle(b, c, d, flags);
  }

  /** Primitives more than 1023 pixels wide or 511 tall are skipped by the GPU. */
  private fitsLimits(a: Vertex, b: Vertex, c: Vertex): boolean {
    const width = Math.max(a.x, b.x, c.x) - Math.min(a.x, b.x, c.x);
    const height = Math.max(a.y, b.y, c.y) - Math.min(a.y, b.y, c.y);
    return width < 1024 && height < 512;
  }

  private lineCommand(op: number): void {
    const words = this.command;
    const shaded = (op & 0x10) !== 0;
    const flags = (shaded ? DRAW_SHADED : 0) | (op & 0x02 ? DRAW_SEMI : 0);
    const [a, b] = this.vertices;
    this.setVertexColor(a, words[0]);
    this.setVertexPosition(a, words[1]);
    this.setVertexColor(b, shaded ? words[2] : words[0]);
    this.setVertexPosition(b, words[shaded ? 3 : 2]);
    this.drawLine(a, b, flags);
  }

  private drawLine(a: Vertex, b: Vertex, flags: number): void {
    if (Math.abs(a.x - b.x) >= 1024 || Math.abs(a.y - b.y) >= 512) return;
    this.prepareRaster();
    this.raster.line(a, b, flags);
  }

  /**
   * Polylines take vertices (each after its colour when shaded) until a word
   * of the form 5xxx5xxx. Each new vertex draws a line from the one before.
   */
  private polylineWord(value: number): void {
    const words = this.command;
    if (this.commandWords >= 2 && (value & 0xf000f000) === 0x50005000) {
      this.commandWords = 0;
      this.polyline = false;
      return;
    }
    words[this.commandWords++] = value;
    const shaded = (words[0] & 0x10000000) !== 0;
    if (this.commandWords !== (shaded ? 4 : 3)) return;
    const flags = (shaded ? DRAW_SHADED : 0) | (words[0] & 0x02000000 ? DRAW_SEMI : 0);
    const [a, b] = this.vertices;
    this.setVertexColor(a, words[0]);
    this.setVertexPosition(a, words[1]);
    this.setVertexColor(b, shaded ? words[2] : words[0]);
    this.setVertexPosition(b, words[this.commandWords - 1]);
    this.drawLine(a, b, flags);
    // The end of this line (and its colour) starts the next.
    if (shaded) {
      words[0] = (words[0] & 0xff000000) | (words[2] & 0xffffff);
      words[1] = words[3];
    } else {
      words[1] = words[2];
    }
    this.commandWords = 2;
  }

  private rectangle(op: number): void {
    const words = this.command;
    const textured = (op & 0x04) !== 0;
    let flags = op & 0x02 ? DRAW_SEMI : 0;
    if (textured) flags |= DRAW_TEXTURED | (op & 0x01 ? DRAW_RAW : 0);
    const color = this.vertices[0];
    this.setVertexColor(color, words[0]);
    this.setVertexPosition(color, words[1]);
    let w = 2;
    let clut = 0;
    if (textured) {
      const uv = words[w++];
      color.u = uv & 0xff;
      color.v = (uv >> 8) & 0xff;
      clut = uv >>> 16;
    }
    let width: number;
    let height: number;
    switch ((op >> 3) & 3) {
      case 0: {
        const size = words[w];
        width = size & 0x3ff;
        height = (size >> 16) & 0x1ff;
        break;
      }
      case 1:
        width = height = 1;
        break;
      case 2:
        width = height = 8;
        break;
      default:
        width = height = 16;
    }
    this.prepareRaster();
    if (textured) {
      this.raster.clutX = (clut & 0x3f) * 16;
      this.raster.clutY = (clut >> 6) & 0x1ff;
    }
    this.raster.rectangle(color.x, color.y, width, height, color, flags, this.rectFlipX, this.rectFlipY);
  }

  /** GP0(02h): fills a rectangle (in 16-pixel steps) ignoring the draw area and mask. */
  private fill(): void {
    const words = this.command;
    const color = words[0];
    const pixel = ((color >> 3) & 0x1f) | (((color >> 11) & 0x1f) << 5) | (((color >> 19) & 0x1f) << 10);
    const x0 = words[1] & 0x3f0;
    const y0 = (words[1] >> 16) & 0x1ff;
    const width = ((words[2] & 0x3ff) + 0xf) & ~0xf;
    const height = (words[2] >> 16) & 0x1ff;
    for (let y = 0; y < height; y++) {
      const row = ((y0 + y) & 511) * VRAM_WIDTH;
      for (let x = 0; x < width; x++) this.vram[row + ((x0 + x) & 1023)] = pixel;
    }
  }

  private copyVram(): void {
    const words = this.command;
    const sx = words[1] & 0x3ff;
    const sy = (words[1] >> 16) & 0x1ff;
    const dx = words[2] & 0x3ff;
    const dy = (words[2] >> 16) & 0x1ff;
    const width = (((words[3] & 0xffff) - 1) & 0x3ff) + 1;
    const height = (((words[3] >>> 16) - 1) & 0x1ff) + 1;
    const line = new Uint16Array(width);
    const maskOr = this.setMask ? 0x8000 : 0;
    for (let y = 0; y < height; y++) {
      const src = ((sy + y) & 511) * VRAM_WIDTH;
      const dst = ((dy + y) & 511) * VRAM_WIDTH;
      for (let x = 0; x < width; x++) line[x] = this.vram[src + ((sx + x) & 1023)];
      for (let x = 0; x < width; x++) {
        const index = dst + ((dx + x) & 1023);
        if (this.checkMask && this.vram[index] & 0x8000) continue;
        this.vram[index] = line[x] | maskOr;
      }
    }
  }

  private startTransfer(upload: boolean): void {
    const words = this.command;
    this.transferX = words[1] & 0x3ff;
    this.transferY = (words[1] >> 16) & 0x1ff;
    this.transferWidth = (((words[2] & 0xffff) - 1) & 0x3ff) + 1;
    this.transferHeight = (((words[2] >>> 16) - 1) & 0x1ff) + 1;
    this.transferIndex = 0;
    const pixels = this.transferWidth * this.transferHeight;
    if (upload) this.uploadRemaining = pixels;
    else this.downloadRemaining = pixels;
  }

  // --- Display ----------------------------------------------------------------------

  /** Converts the displayed part of VRAM to RGBA for the screen. */
  private scanOut(): void {
    const timing = TIMING[this.standard];
    const { width: hresWidth, divider } = this.hres;
    const rangeWidth = Math.round((this.hRangeEnd - this.hRangeStart) / divider);
    const width = Math.min(hresWidth, rangeWidth > 16 ? (rangeWidth + 2) & ~3 : hresWidth);
    let lines = Math.min(timing.visibleLines, Math.max(0, this.vRangeEnd - this.vRangeStart));
    if (lines < 16) lines = timing.visibleLines === 240 ? 240 : 256;
    const doubled = this.interlaced && (this.displayMode & 0x04) !== 0;
    const height = doubled ? lines * 2 : lines;
    this.frameWidth = width;
    this.frameHeight = height;
    const out = this.framebuffer;
    if (this.displayDisabled) {
      out.fill(0xff000000, 0, width * height);
      return;
    }
    const vram = this.vram;
    const is24 = (this.displayMode & 0x10) !== 0;
    for (let y = 0; y < height; y++) {
      const row = ((this.displayY + y) & 511) * VRAM_WIDTH;
      let o = y * width;
      if (is24) {
        let byte = this.displayX * 2;
        for (let x = 0; x < width; x++, byte += 3) {
          const b0 = this.vramByte(row, byte);
          const b1 = this.vramByte(row, byte + 1);
          const b2 = this.vramByte(row, byte + 2);
          out[o++] = (0xff000000 | (b2 << 16) | (b1 << 8) | b0) >>> 0;
        }
      } else {
        for (let x = 0; x < width; x++) {
          const p = vram[row + ((this.displayX + x) & 1023)];
          const r = (p & 0x1f) << 3;
          const g = ((p >> 5) & 0x1f) << 3;
          const b = ((p >> 10) & 0x1f) << 3;
          out[o++] = (0xff000000 | ((b | (b >> 5)) << 16) | ((g | (g >> 5)) << 8) | r | (r >> 5)) >>> 0;
        }
      }
    }
  }

  private vramByte(row: number, byte: number): number {
    const word = this.vram[row + ((byte >> 1) & 1023)];
    return byte & 1 ? word >> 8 : word & 0xff;
  }
}
