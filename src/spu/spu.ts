import { Irq, type Interrupts } from '../irq';
import { TimedEvent, type Scheduler } from '../scheduler';

/** The SPU makes one stereo sample every 768 CPU cycles: 44.1 kHz. */
export const CYCLES_PER_SAMPLE = 768;
export const SAMPLE_RATE = 44100;
const RAM_SIZE = 0x80000;
/** Samples made per scheduled wake-up (register accesses catch up in between). */
const BATCH = 32;

const POS_FILTER = [0, 60, 115, 98, 122];
const NEG_FILTER = [0, 0, -52, -55, -60];

const PHASE_OFF = 0;
const PHASE_ATTACK = 1;
const PHASE_DECAY = 2;
const PHASE_SUSTAIN = 3;
const PHASE_RELEASE = 4;

const clamp16 = (value: number) => (value < -0x8000 ? -0x8000 : value > 0x7fff ? 0x7fff : value);
const s16 = (value: number) => (value << 16) >> 16;

/** One step of a volume envelope (ADSR or sweep): how many samples to wait and how far to move. */
class Envelope {
  counter = 0;

  /** Moves `level` one step, or waits: slow rates (big shifts) step every few samples. */
  step(level: number, shift: number, stepValue: number, exponential: boolean, decreasing: boolean): number {
    if (this.counter > 0) {
      this.counter--;
      return level;
    }
    let cycles = 1 << Math.max(0, shift - 11);
    let step = stepValue << Math.max(0, 11 - shift);
    if (exponential && !decreasing && level > 0x6000) cycles *= 4;
    if (exponential && decreasing) step = Math.trunc((step * level) / 0x8000);
    this.counter = cycles - 1;
    level += step;
    return level < 0 ? 0 : level > 0x7fff ? 0x7fff : level;
  }
}

/** A voice's volume register: fixed (bit 15 clear) or sweeping up or down. */
class Volume {
  register = 0;
  level = 0;
  private readonly sweep = new Envelope();

  write(value: number): void {
    this.register = value & 0xffff;
    if (!(value & 0x8000)) this.level = s16(value << 1);
  }

  tick(): void {
    const value = this.register;
    if (!(value & 0x8000)) return;
    const exponential = (value & 0x4000) !== 0;
    const decreasing = (value & 0x2000) !== 0;
    const shift = (value >> 2) & 0x1f;
    const step = value & 3;
    const magnitude = Math.abs(this.level);
    const next = this.sweep.step(magnitude, shift, decreasing ? -8 + step : 7 - step, exponential, decreasing);
    this.level = value & 0x1000 ? -next : next;
  }
}

class Voice {
  readonly volumeLeft = new Volume();
  readonly volumeRight = new Volume();
  pitch = 0;
  startAddress = 0;
  repeatAddress = 0;
  adsr = 0;
  adsrLevel = 0;
  phase = PHASE_OFF;
  readonly envelope = new Envelope();

  currentAddress = 0;
  counter = 0;
  readonly samples = new Int16Array(28);
  /** The last three samples of the previous block, for interpolation across blocks. */
  readonly history = new Int16Array(3);
  previous1 = 0;
  previous2 = 0;
  /** This voice's last output (before volume), for the next voice's pitch modulation. */
  output = 0;
  /** Set on key-on: the first block must be decoded before playing. */
  needsBlock = true;
  blockFlags = 0;

  keyOn(): void {
    this.currentAddress = this.startAddress;
    this.counter = 0;
    this.adsrLevel = 0;
    this.phase = PHASE_ATTACK;
    this.envelope.counter = 0;
    this.previous1 = this.previous2 = 0;
    this.history.fill(0);
    this.needsBlock = true;
  }

  keyOff(): void {
    if (this.phase !== PHASE_OFF) {
      this.phase = PHASE_RELEASE;
      this.envelope.counter = 0;
    }
  }

  tickEnvelope(): void {
    const adsr = this.adsr;
    switch (this.phase) {
      case PHASE_ATTACK: {
        const exponential = (adsr & 0x8000) !== 0;
        const shift = (adsr >> 10) & 0x1f;
        const step = 7 - ((adsr >> 8) & 3);
        this.adsrLevel = this.envelope.step(this.adsrLevel, shift, step, exponential, false);
        if (this.adsrLevel >= 0x7fff) {
          this.phase = PHASE_DECAY;
          this.envelope.counter = 0;
        }
        break;
      }
      case PHASE_DECAY: {
        const shift = (adsr >> 4) & 0xf;
        this.adsrLevel = this.envelope.step(this.adsrLevel, shift, -8, true, true);
        const sustain = Math.min(0x7fff, ((adsr & 0xf) + 1) * 0x800);
        if (this.adsrLevel <= sustain) {
          this.phase = PHASE_SUSTAIN;
          this.envelope.counter = 0;
        }
        break;
      }
      case PHASE_SUSTAIN: {
        const exponential = (adsr & 0x80000000) !== 0;
        const decreasing = (adsr & 0x40000000) !== 0;
        const shift = (adsr >>> 24) & 0x1f;
        const step = (adsr >>> 22) & 3;
        this.adsrLevel = this.envelope.step(this.adsrLevel, shift, decreasing ? -8 + step : 7 - step, exponential, decreasing);
        break;
      }
      case PHASE_RELEASE: {
        const exponential = (adsr & 0x200000) !== 0;
        const shift = (adsr >>> 16) & 0x1f;
        this.adsrLevel = this.envelope.step(this.adsrLevel, shift, -8, exponential, true);
        if (this.adsrLevel <= 0) {
          this.adsrLevel = 0;
          this.phase = PHASE_OFF;
        }
        break;
      }
    }
  }
}

/** Reverb register indices (0x1C0 onwards, in halfwords). */
const R = {
  dAPF1: 0,
  dAPF2: 1,
  vIIR: 2,
  vCOMB1: 3,
  vCOMB2: 4,
  vCOMB3: 5,
  vCOMB4: 6,
  vWALL: 7,
  vAPF1: 8,
  vAPF2: 9,
  mLSAME: 10,
  mRSAME: 11,
  mLCOMB1: 12,
  mRCOMB1: 13,
  mLCOMB2: 14,
  mRCOMB2: 15,
  dLSAME: 16,
  dRSAME: 17,
  mLDIFF: 18,
  mRDIFF: 19,
  mLCOMB3: 20,
  mRCOMB3: 21,
  mLCOMB4: 22,
  mRCOMB4: 23,
  dLDIFF: 24,
  dRDIFF: 25,
  mLAPF1: 26,
  mRAPF1: 27,
  mLAPF2: 28,
  mRAPF2: 29,
  vLIN: 30,
  vRIN: 31,
} as const;

/** The CD-ROM's audio, as the SPU takes it: one stereo sample per SPU tick. */
export interface CdAudioSource {
  /** Returns [left, right] (already through the CD-ROM's own volume), or zeros when nothing plays. */
  nextSample(out: Int16Array): void;
}

/**
 * The SPU: 24 voices playing 4-bit ADPCM from its 512K of sound RAM, each
 * with an ADSR envelope, optional pitch modulation by the voice before and
 * noise; a reverb unit working in sound RAM; and the CD audio input.
 */
export class Spu {
  readonly ram = new Uint8Array(RAM_SIZE);
  private readonly ram16 = new Uint16Array(this.ram.buffer);
  readonly voices = Array.from({ length: 24 }, () => new Voice());
  readonly mainLeft = new Volume();
  readonly mainRight = new Volume();
  reverbOutLeft = 0;
  reverbOutRight = 0;
  readonly reverb = new Int16Array(32);
  reverbBase = 0;
  private reverbAddress = 0;
  private reverbLeft = 0;
  private reverbRight = 0;
  private reverbTick = 0;
  pitchMod = 0;
  noiseOn = 0;
  reverbOn = 0;
  endx = 0;
  control = 0;
  status = 0;
  irqAddress = 0;
  transferAddress = 0;
  private transferRegister = 0;
  transferControl = 4;
  cdVolumeLeft = 0;
  cdVolumeRight = 0;
  externLeft = 0;
  externRight = 0;
  private noiseLevel = 1;
  private noiseTimer = 0;
  private captureIndex = 0;
  /** Registers that just read back what was written. */
  private readonly registers = new Uint16Array(0x200);

  private lastSync = 0;
  private readonly event: TimedEvent;
  private readonly cdSample = new Int16Array(2);
  /** Finished stereo samples, interleaved, waiting to be played. */
  private outputBuffer = new Float32Array(8192);
  private outputLength = 0;
  cdAudio: CdAudioSource | null = null;

  constructor(
    private readonly sched: Scheduler,
    private readonly irq: Interrupts,
  ) {
    this.event = sched.add(new TimedEvent('spu', () => this.wake()));
  }

  reset(): void {
    this.ram.fill(0);
    for (const voice of this.voices) {
      Object.assign(voice, { pitch: 0, startAddress: 0, repeatAddress: 0, adsr: 0, adsrLevel: 0, phase: PHASE_OFF, currentAddress: 0, counter: 0 });
      voice.volumeLeft.write(0);
      voice.volumeRight.write(0);
    }
    this.mainLeft.write(0);
    this.mainRight.write(0);
    this.reverb.fill(0);
    this.registers.fill(0);
    this.reverbOutLeft = this.reverbOutRight = this.reverbBase = this.reverbAddress = 0;
    this.pitchMod = this.noiseOn = this.reverbOn = this.endx = this.control = this.status = 0;
    this.irqAddress = this.transferAddress = 0;
    this.transferControl = 4;
    this.cdVolumeLeft = this.cdVolumeRight = this.externLeft = this.externRight = 0;
    this.noiseLevel = 1;
    this.noiseTimer = this.captureIndex = 0;
    this.outputLength = 0;
    this.lastSync = this.sched.now;
    this.sched.schedule(this.event, BATCH * CYCLES_PER_SAMPLE);
  }

  private wake(): void {
    this.sync();
    this.sched.schedule(this.event, BATCH * CYCLES_PER_SAMPLE);
  }

  /** Makes the samples due up to now. */
  sync(): void {
    const samples = Math.floor((this.sched.now - this.lastSync) / CYCLES_PER_SAMPLE);
    if (samples <= 0) return;
    this.lastSync += samples * CYCLES_PER_SAMPLE;
    for (let i = 0; i < samples; i++) this.tick();
  }

  /** Takes the samples made so far (interleaved left/right, -1..1). */
  takeSamples(): Float32Array {
    const samples = this.outputBuffer.slice(0, this.outputLength);
    this.outputLength = 0;
    return samples;
  }

  // --- Registers --------------------------------------------------------------------

  read16(offset: number): number {
    this.sync();
    if (offset < 0x180) {
      const voice = this.voices[offset >> 4];
      switch (offset & 0xf) {
        case 0x0:
          return voice.volumeLeft.register;
        case 0x2:
          return voice.volumeRight.register;
        case 0x4:
          return voice.pitch;
        case 0x6:
          return voice.startAddress >> 3;
        case 0x8:
          return voice.adsr & 0xffff;
        case 0xa:
          return voice.adsr >>> 16;
        case 0xc:
          return voice.adsrLevel;
        default:
          return voice.repeatAddress >> 3;
      }
    }
    if (offset >= 0x1c0 && offset < 0x200) return this.reverb[(offset - 0x1c0) >> 1] & 0xffff;
    if (offset >= 0x200 && offset < 0x260) {
      const voice = this.voices[(offset - 0x200) >> 2];
      return (offset & 2 ? voice.volumeRight.level : voice.volumeLeft.level) & 0xffff;
    }
    switch (offset) {
      case 0x180:
        return this.mainLeft.register;
      case 0x182:
        return this.mainRight.register;
      case 0x184:
        return this.reverbOutLeft & 0xffff;
      case 0x186:
        return this.reverbOutRight & 0xffff;
      case 0x190:
        return this.pitchMod & 0xffff;
      case 0x192:
        return this.pitchMod >>> 16;
      case 0x194:
        return this.noiseOn & 0xffff;
      case 0x196:
        return this.noiseOn >>> 16;
      case 0x198:
        return this.reverbOn & 0xffff;
      case 0x19a:
        return this.reverbOn >>> 16;
      case 0x19c:
        return this.endx & 0xffff;
      case 0x19e:
        return this.endx >>> 16;
      case 0x1a2:
        return this.reverbBase >> 3;
      case 0x1a4:
        return this.irqAddress >> 3;
      case 0x1a6:
        return this.transferRegister;
      case 0x1aa:
        return this.control;
      case 0x1ac:
        return this.transferControl;
      case 0x1ae:
        return this.readStatus();
      case 0x1b0:
        return this.cdVolumeLeft & 0xffff;
      case 0x1b2:
        return this.cdVolumeRight & 0xffff;
      case 0x1b4:
        return this.externLeft & 0xffff;
      case 0x1b6:
        return this.externRight & 0xffff;
      case 0x1b8:
        return this.mainLeft.level & 0xffff;
      case 0x1ba:
        return this.mainRight.level & 0xffff;
      default:
        return this.registers[offset >> 1];
    }
  }

  private readStatus(): number {
    let status = (this.control & 0x3f) | (this.status & 0x40);
    const mode = (this.control >> 4) & 3;
    if (mode === 2) status |= 0x100 | 0x80;
    if (mode === 3) status |= 0x200 | 0x80;
    if (this.captureIndex & 0x100) status |= 0x800;
    return status;
  }

  write16(offset: number, value: number): void {
    this.sync();
    value &= 0xffff;
    this.registers[offset >> 1] = value;
    if (offset < 0x180) {
      const voice = this.voices[offset >> 4];
      switch (offset & 0xf) {
        case 0x0:
          voice.volumeLeft.write(value);
          return;
        case 0x2:
          voice.volumeRight.write(value);
          return;
        case 0x4:
          voice.pitch = value;
          return;
        case 0x6:
          voice.startAddress = value << 3;
          return;
        case 0x8:
          voice.adsr = ((voice.adsr & 0xffff0000) | value) >>> 0;
          return;
        case 0xa:
          voice.adsr = ((voice.adsr & 0xffff) | (value << 16)) >>> 0;
          return;
        case 0xc:
          voice.adsrLevel = s16(value);
          return;
        default:
          voice.repeatAddress = value << 3;
          return;
      }
    }
    if (offset >= 0x1c0 && offset < 0x200) {
      this.reverb[(offset - 0x1c0) >> 1] = value;
      return;
    }
    switch (offset) {
      case 0x180:
        this.mainLeft.write(value);
        return;
      case 0x182:
        this.mainRight.write(value);
        return;
      case 0x184:
        this.reverbOutLeft = s16(value);
        return;
      case 0x186:
        this.reverbOutRight = s16(value);
        return;
      case 0x188:
        this.keyOn(value);
        return;
      case 0x18a:
        this.keyOn(value << 16);
        return;
      case 0x18c:
        this.keyOff(value);
        return;
      case 0x18e:
        this.keyOff(value << 16);
        return;
      case 0x190:
        this.pitchMod = ((this.pitchMod & 0xffff0000) | (value & 0xfffe)) >>> 0;
        return;
      case 0x192:
        this.pitchMod = ((this.pitchMod & 0xffff) | ((value & 0xff) << 16)) >>> 0;
        return;
      case 0x194:
        this.noiseOn = ((this.noiseOn & 0xffff0000) | value) >>> 0;
        return;
      case 0x196:
        this.noiseOn = ((this.noiseOn & 0xffff) | ((value & 0xff) << 16)) >>> 0;
        return;
      case 0x198:
        this.reverbOn = ((this.reverbOn & 0xffff0000) | value) >>> 0;
        return;
      case 0x19a:
        this.reverbOn = ((this.reverbOn & 0xffff) | ((value & 0xff) << 16)) >>> 0;
        return;
      case 0x1a2:
        this.reverbBase = value << 3;
        this.reverbAddress = this.reverbBase;
        return;
      case 0x1a4:
        this.irqAddress = value << 3;
        return;
      case 0x1a6:
        this.transferRegister = value;
        this.transferAddress = value << 3;
        return;
      case 0x1a8:
        this.writeRam(value);
        return;
      case 0x1aa:
        this.control = value;
        if (!(value & 0x40)) this.status &= ~0x40;
        return;
      case 0x1ac:
        this.transferControl = value;
        return;
      case 0x1b0:
        this.cdVolumeLeft = s16(value);
        return;
      case 0x1b2:
        this.cdVolumeRight = s16(value);
        return;
      case 0x1b4:
        this.externLeft = s16(value);
        return;
      case 0x1b6:
        this.externRight = s16(value);
        return;
    }
  }

  private keyOn(bits: number): void {
    for (let i = 0; i < 24; i++) {
      if (bits & (1 << i)) {
        this.voices[i].keyOn();
        this.endx &= ~(1 << i);
      }
    }
  }

  private keyOff(bits: number): void {
    for (let i = 0; i < 24; i++) if (bits & (1 << i)) this.voices[i].keyOff();
  }

  // --- Sound RAM --------------------------------------------------------------------

  private checkIrq(address: number): void {
    if (this.control & 0x40 && (address & ~1) === this.irqAddress && !(this.status & 0x40)) {
      this.status |= 0x40;
      this.irq.raise(Irq.Spu);
    }
  }

  private writeRam(value: number): void {
    const address = this.transferAddress & (RAM_SIZE - 2);
    this.ram16[address >> 1] = value;
    this.checkIrq(address);
    this.transferAddress = (address + 2) & (RAM_SIZE - 1);
  }

  private readRam(): number {
    const address = this.transferAddress & (RAM_SIZE - 2);
    const value = this.ram16[address >> 1];
    this.checkIrq(address);
    this.transferAddress = (address + 2) & (RAM_SIZE - 1);
    return value;
  }

  dmaWrite(word: number): void {
    this.sync();
    this.writeRam(word & 0xffff);
    this.writeRam(word >>> 16);
  }

  dmaRead(): number {
    this.sync();
    return (this.readRam() | (this.readRam() << 16)) | 0;
  }

  // --- Sample generation ------------------------------------------------------------

  /** Decodes the 16-byte ADPCM block at the voice's address into 28 samples. */
  private decodeBlock(voice: Voice): void {
    const address = voice.currentAddress & (RAM_SIZE - 16);
    const ram = this.ram;
    for (let i = 0; i < 16; i += 2) this.checkIrq(address + i);
    const header = ram[address];
    let shift = header & 0xf;
    if (shift > 12) shift = 9;
    const filter = Math.min(4, (header >> 4) & 7);
    const pos = POS_FILTER[filter];
    const neg = NEG_FILTER[filter];
    voice.blockFlags = ram[address + 1];
    if (voice.blockFlags & 4) voice.repeatAddress = address;
    let p1 = voice.previous1;
    let p2 = voice.previous2;
    for (let i = 0; i < 28; i++) {
      const byte = ram[address + 2 + (i >> 1)];
      const nibble = i & 1 ? byte >> 4 : byte & 0xf;
      let sample = (s16(nibble << 12) >> shift) + ((p1 * pos + p2 * neg + 32) >> 6);
      sample = clamp16(sample);
      voice.samples[i] = sample;
      p2 = p1;
      p1 = sample;
    }
    voice.previous1 = p1;
    voice.previous2 = p2;
  }

  /**
   * The voice's sample at its current position, interpolated over the newest
   * four samples (Catmull-Rom in place of the hardware's Gaussian table).
   */
  private sampleAt(voice: Voice): number {
    const index = voice.counter >> 12;
    const t = (voice.counter & 0xfff) / 0x1000;
    const at = (i: number) => (i >= 0 ? voice.samples[i] : voice.history[3 + i]);
    const s0 = at(index - 3);
    const s1 = at(index - 2);
    const s2 = at(index - 1);
    const s3 = at(index);
    const a = -0.5 * s0 + 1.5 * s1 - 1.5 * s2 + 0.5 * s3;
    const b = s0 - 2.5 * s1 + 2 * s2 - 0.5 * s3;
    const c = -0.5 * s0 + 0.5 * s2;
    return clamp16(Math.round(((a * t + b) * t + c) * t + s1));
  }

  private stepNoise(): void {
    const step = 4 + ((this.control >> 8) & 3);
    const shift = (this.control >> 10) & 0xf;
    this.noiseTimer -= step;
    const level = this.noiseLevel;
    const parity = ((level >> 15) ^ (level >> 12) ^ (level >> 11) ^ (level >> 10) ^ 1) & 1;
    if (this.noiseTimer < 0) {
      this.noiseLevel = s16((level << 1) | parity);
      this.noiseTimer += 0x20000 >> shift;
      if (this.noiseTimer < 0) this.noiseTimer += 0x20000 >> shift;
    }
  }

  private writeCapture(region: number, value: number): void {
    const address = region + ((this.captureIndex & 0x1ff) << 1);
    this.ram16[address >> 1] = value & 0xffff;
    this.checkIrq(address);
  }

  private tick(): void {
    let left = 0;
    let right = 0;
    let reverbLeft = 0;
    let reverbRight = 0;
    const enabled = (this.control & 0x8000) !== 0;
    this.stepNoise();

    for (let i = 0; i < 24; i++) {
      const voice = this.voices[i];
      if (voice.needsBlock) {
        this.decodeBlock(voice);
        voice.needsBlock = false;
      }
      let sample = 0;
      if (voice.phase !== PHASE_OFF) {
        const raw = this.noiseOn & (1 << i) ? this.noiseLevel : this.sampleAt(voice);
        sample = (raw * voice.adsrLevel) >> 15;
      }
      voice.output = sample;
      if (i === 1) this.writeCapture(0x800, sample);
      if (i === 3) this.writeCapture(0xc00, sample);

      // Advance the voice through its samples.
      let step = voice.pitch;
      if (this.pitchMod & (1 << i) && i > 0) {
        const factor = this.voices[i - 1].output + 0x8000;
        step = Math.trunc((s16(step) * factor) / 0x8000) & 0xffff;
      }
      if (step > 0x3fff) step = 0x4000;
      voice.counter += step;
      while (voice.counter >= 28 << 12) {
        voice.counter -= 28 << 12;
        voice.history[0] = voice.samples[25];
        voice.history[1] = voice.samples[26];
        voice.history[2] = voice.samples[27];
        this.endOfBlock(voice, i);
        this.decodeBlock(voice);
      }
      voice.tickEnvelope();
      voice.volumeLeft.tick();
      voice.volumeRight.tick();

      if (voice.phase === PHASE_OFF && voice.adsrLevel === 0) continue;
      const l = (sample * voice.volumeLeft.level) >> 15;
      const r = (sample * voice.volumeRight.level) >> 15;
      left += l;
      right += r;
      if (this.reverbOn & (1 << i)) {
        reverbLeft += l;
        reverbRight += r;
      }
    }

    // CD audio comes in whether or not it is mixed in.
    let cdLeft = 0;
    let cdRight = 0;
    if (this.cdAudio) {
      this.cdAudio.nextSample(this.cdSample);
      cdLeft = this.cdSample[0];
      cdRight = this.cdSample[1];
    }
    this.writeCapture(0x000, cdLeft);
    this.writeCapture(0x400, cdRight);
    this.captureIndex = (this.captureIndex + 1) & 0x3ff;
    if (this.control & 0x1) {
      const l = (cdLeft * this.cdVolumeLeft) >> 15;
      const r = (cdRight * this.cdVolumeRight) >> 15;
      left += l;
      right += r;
      if (this.control & 0x4) {
        reverbLeft += l;
        reverbRight += r;
      }
    }

    if (this.reverbTick ^= 1) this.processReverb(clamp16(reverbLeft), clamp16(reverbRight));
    if (this.control & 0x80) {
      left += this.reverbLeft;
      right += this.reverbRight;
    }

    this.mainLeft.tick();
    this.mainRight.tick();
    let outLeft = 0;
    let outRight = 0;
    if (enabled && this.control & 0x4000) {
      outLeft = clamp16((clamp16(left) * this.mainLeft.level) >> 15);
      outRight = clamp16((clamp16(right) * this.mainRight.level) >> 15);
    }
    if (this.outputLength + 2 > this.outputBuffer.length) {
      const bigger = new Float32Array(this.outputBuffer.length * 2);
      bigger.set(this.outputBuffer);
      this.outputBuffer = bigger;
    }
    this.outputBuffer[this.outputLength++] = outLeft / 0x8000;
    this.outputBuffer[this.outputLength++] = outRight / 0x8000;
  }

  private endOfBlock(voice: Voice, index: number): void {
    const flags = voice.blockFlags;
    if (flags & 1) {
      this.endx |= 1 << index;
      voice.currentAddress = voice.repeatAddress;
      if (!(flags & 2)) {
        // A loop end without repeat silences the voice.
        voice.phase = PHASE_OFF;
        voice.adsrLevel = 0;
      }
    } else {
      voice.currentAddress = (voice.currentAddress + 16) & (RAM_SIZE - 1);
    }
  }

  // --- Reverb -----------------------------------------------------------------------

  /** A reverb buffer address (register value × 8 bytes from the current position), wrapped within the work area. */
  private reverbOffset(offset: number): number {
    const base = this.reverbBase;
    const size = RAM_SIZE - base;
    if (size <= 0) return 0;
    let address = this.reverbAddress + offset - base;
    if (address < 0 || address >= size) address = ((address % size) + size) % size;
    return (base + address) & (RAM_SIZE - 2);
  }

  private reverbRead(register: number, adjust = 0): number {
    return s16(this.ram16[this.reverbOffset((this.reverb[register] & 0xffff) * 8 + adjust) >> 1]);
  }

  private reverbWrite(register: number, value: number): void {
    if (!(this.control & 0x80)) return;
    this.ram16[this.reverbOffset((this.reverb[register] & 0xffff) * 8) >> 1] = clamp16(value) & 0xffff;
  }

  private processReverb(inLeft: number, inRight: number): void {
    const v = this.reverb;
    const mul = (a: number, b: number) => (a * b) >> 15;
    const lin = mul(inLeft, v[R.vLIN]);
    const rin = mul(inRight, v[R.vRIN]);
    const iir = v[R.vIIR];
    const wall = v[R.vWALL];

    const lSame = clamp16(mul(lin + mul(this.reverbRead(R.dLSAME), wall) - this.reverbRead(R.mLSAME, -2), iir) + this.reverbRead(R.mLSAME, -2));
    const rSame = clamp16(mul(rin + mul(this.reverbRead(R.dRSAME), wall) - this.reverbRead(R.mRSAME, -2), iir) + this.reverbRead(R.mRSAME, -2));
    const lDiff = clamp16(mul(lin + mul(this.reverbRead(R.dRDIFF), wall) - this.reverbRead(R.mLDIFF, -2), iir) + this.reverbRead(R.mLDIFF, -2));
    const rDiff = clamp16(mul(rin + mul(this.reverbRead(R.dLDIFF), wall) - this.reverbRead(R.mRDIFF, -2), iir) + this.reverbRead(R.mRDIFF, -2));
    this.reverbWrite(R.mLSAME, lSame);
    this.reverbWrite(R.mRSAME, rSame);
    this.reverbWrite(R.mLDIFF, lDiff);
    this.reverbWrite(R.mRDIFF, rDiff);

    let lOut = clamp16(
      mul(v[R.vCOMB1], this.reverbRead(R.mLCOMB1)) + mul(v[R.vCOMB2], this.reverbRead(R.mLCOMB2)) + mul(v[R.vCOMB3], this.reverbRead(R.mLCOMB3)) + mul(v[R.vCOMB4], this.reverbRead(R.mLCOMB4)),
    );
    let rOut = clamp16(
      mul(v[R.vCOMB1], this.reverbRead(R.mRCOMB1)) + mul(v[R.vCOMB2], this.reverbRead(R.mRCOMB2)) + mul(v[R.vCOMB3], this.reverbRead(R.mRCOMB3)) + mul(v[R.vCOMB4], this.reverbRead(R.mRCOMB4)),
    );

    const apf = (out: number, m: number, d: number, gain: number) => {
      const delayed = this.reverbRead(m, -(v[d] & 0xffff) * 8);
      const value = clamp16(out - mul(gain, delayed));
      this.reverbWrite(m, value);
      return clamp16(mul(value, gain) + delayed);
    };
    lOut = apf(lOut, R.mLAPF1, R.dAPF1, v[R.vAPF1]);
    rOut = apf(rOut, R.mRAPF1, R.dAPF1, v[R.vAPF1]);
    lOut = apf(lOut, R.mLAPF2, R.dAPF2, v[R.vAPF2]);
    rOut = apf(rOut, R.mRAPF2, R.dAPF2, v[R.vAPF2]);

    this.reverbLeft = mul(lOut, this.reverbOutLeft);
    this.reverbRight = mul(rOut, this.reverbOutRight);
    this.reverbAddress = Math.max(this.reverbBase, (this.reverbAddress + 2) & (RAM_SIZE - 2));
    if (this.reverbAddress >= RAM_SIZE) this.reverbAddress = this.reverbBase;
  }
}
