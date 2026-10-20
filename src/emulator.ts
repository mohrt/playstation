import type { LoadedMedia } from './media';
import { PlayStation } from './playstation';
import type { ConsoleStatus, Rumble } from './protocol';
import type { Screen } from './render/screen';
import { CPU_HZ } from './scheduler';
import type { PadState, PadType } from './sio/pad';
import { SAMPLE_RATE } from './spu/spu';
import { captureState, restoreState } from './state/snapshot';
import { decodeSession, encodeSession, type MediaInfo } from './storage/save-states';

/** Longest gap we catch up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_CATCH_UP_MS = 100;
/** How much faster than real time fast-forward runs (if the computer keeps up). */
const FAST_FORWARD = 4;

/** Converts the SPU's 44.1 kHz stereo to the speakers' rate (linear interpolation). */
class Resampler {
  private position = 0;
  private lastLeft = 0;
  private lastRight = 0;

  constructor(private readonly outputRate: number) {}

  convert(input: Float32Array): Float32Array {
    if (this.outputRate === SAMPLE_RATE) return input;
    const step = SAMPLE_RATE / this.outputRate;
    const frames = input.length / 2;
    const output: number[] = [];
    let position = this.position;
    while (position < frames) {
      const index = Math.floor(position);
      const t = position - index;
      const l0 = index === 0 ? this.lastLeft : input[(index - 1) * 2];
      const r0 = index === 0 ? this.lastRight : input[(index - 1) * 2 + 1];
      output.push(l0 + (input[index * 2] - l0) * t, r0 + (input[index * 2 + 1] - r0) * t);
      position += step;
    }
    this.position = position - frames;
    if (frames > 0) {
      this.lastLeft = input[(frames - 1) * 2];
      this.lastRight = input[(frames - 1) * 2 + 1];
    }
    return Float32Array.from(output);
  }
}

/**
 * The console as the worker runs it: in step with real time, with its
 * pictures going to the screen and its sound to the audio worklet.
 */
export class Emulator {
  readonly machine = new PlayStation();
  private clockDebt = 0;
  private media: LoadedMedia | null = null;
  private resampler: Resampler;
  private newFrame = false;
  private openBios: Uint8Array | null = null;
  private userBios: Uint8Array | null = null;
  private useUserBios = false;
  soundEnabled = true;
  /** Characters printed by the program (through the BIOS), for the page's console log. */
  tty = '';

  constructor(
    private readonly screen: Screen | null,
    private readonly audioPort: MessagePort | null,
    sampleRate: number,
  ) {
    this.resampler = new Resampler(sampleRate);
    this.machine.gpu.onFrame = () => (this.newFrame = true);
    this.machine.onTty = (char) => {
      this.tty += String.fromCharCode(char);
      if (this.tty.length > 8192) this.tty = this.tty.slice(-4096);
    };
  }

  get canRun(): boolean {
    return this.machine.hasBios && this.media !== null;
  }

  get title(): string | null {
    return this.media?.title ?? null;
  }

  /** The free OpenBIOS, and optionally the player's own (used when `useUser` is set). */
  setBios(openBios: Uint8Array | null, userBios: Uint8Array | null, useUser: boolean): void {
    if (openBios) this.openBios = openBios;
    this.userBios = userBios;
    this.useUserBios = useUser && userBios !== null;
    const image = this.useUserBios ? this.userBios : this.openBios;
    if (image) this.machine.loadBios(image);
  }

  get biosName(): string {
    return this.useUserBios ? 'your BIOS' : 'OpenBIOS';
  }

  insert(media: LoadedMedia | null): void {
    this.media = media;
    if (media?.kind === 'disc') {
      this.machine.setExe(null);
      this.machine.insertDisc(media.disc, media.info.region);
    } else {
      this.machine.insertDisc(null);
      this.machine.setExe(media?.kind === 'exe' ? media.exe : null);
    }
    this.powerOn();
  }

  /** Changes discs without restarting (the next disc of a multi-disc game). */
  swap(media: LoadedMedia & { kind: 'disc' }): void {
    this.media = media;
    this.machine.cdrom.swapDisc(media.disc, media.info.region);
  }

  get hasDisc(): boolean {
    return this.media?.kind === 'disc';
  }

  powerOn(): void {
    if (this.media?.kind === 'exe') this.machine.setExe(this.media.exe);
    this.machine.powerOn();
    this.clockDebt = 0;
  }

  /** Each player's controls (players 1-4 are on port 1's Multitap when one is plugged in). */
  setPads(pads: PadState[]): void {
    const players = this.machine.sio.playerPads;
    pads.forEach((state, i) => {
      if (players[i]) players[i].state = state;
    });
  }

  setMultitap(plugged: boolean): void {
    this.machine.sio.taps[0].plugged = plugged;
  }

  setPadTypes(types: PadType[]): void {
    types.forEach((type, i) => {
      const pad = this.machine.sio.pads[i];
      if (!pad || pad.type === type) return;
      pad.type = type;
      pad.analog = false;
    });
  }

  /** Each player's motors (still while the console isn't `running`). */
  rumble(running: boolean): Rumble[] {
    return this.machine.sio.playerPads.map((pad) => (running ? { strong: pad.largeMotor / 255, weak: pad.smallMotor / 255 } : { strong: 0, weak: 0 }));
  }

  /** The DualShock's Analog button. */
  toggleAnalog(port: number): void {
    const pad = this.machine.sio.pads[port];
    if (pad?.type === 'dualshock') pad.analog = !pad.analog;
  }

  status(): ConsoleStatus {
    return {
      title: this.media?.title ?? null,
      kind: this.media?.kind ?? null,
      details: this.media?.details ?? '',
      bios: this.biosName,
      pads: this.machine.sio.pads.map((pad) => ({ type: pad.type, analog: pad.analog })),
      multitap: this.machine.sio.taps[0].plugged,
    };
  }

  /** Runs the console for `elapsedMs` of real time, then shows the newest picture and plays the sound. */
  run(elapsedMs: number, fastForward: boolean): void {
    if (!this.canRun) {
      this.screen?.showIdle();
      return;
    }
    const speed = fastForward ? FAST_FORWARD : 1;
    this.clockDebt += (Math.min(elapsedMs, MAX_CATCH_UP_MS) * speed * CPU_HZ) / 1000;
    const cycles = Math.floor(this.clockDebt);
    if (cycles > 0) {
      const before = this.machine.sched.now;
      this.machine.run(cycles);
      const ran = this.machine.sched.now - before;
      this.clockDebt -= ran;
      if (!fastForward) this.measureSpeed(elapsedMs, (ran * 1000) / CPU_HZ);
    }
    this.machine.spu.sync();
    const samples = this.machine.spu.takeSamples();
    if (this.newFrame) {
      this.newFrame = false;
      const gpu = this.machine.gpu;
      this.screen?.present(gpu.framebuffer, gpu.frameWidth, gpu.frameHeight);
    }
    if (this.audioPort && this.soundEnabled && !fastForward && samples.length) {
      const output = this.resampler.convert(samples);
      this.audioPort.postMessage(output, [output.buffer]);
    }
  }

  resetTiming(): void {
    this.clockDebt = 0;
    this.realMs = this.emulatedMs = 0;
  }

  private realMs = 0;
  private emulatedMs = 0;
  /** Emulated time over real time, over the last second or so (1 = full speed). */
  speed = 1;

  private measureSpeed(realMs: number, emulatedMs: number): void {
    this.realMs += realMs;
    this.emulatedMs += emulatedMs;
    if (this.realMs < 1000) return;
    this.speed = Math.min(1, this.emulatedMs / this.realMs);
    this.realMs = this.emulatedMs = 0;
  }

  /** Memory cards written since last asked, by slot. */
  takeDirtyCards(): { slot: number; data: Uint8Array }[] {
    return this.machine.sio.cards.flatMap((card, slot) => {
      if (!card.dirty) return [];
      card.dirty = false;
      return [{ slot, data: card.data.slice() }];
    });
  }

  async saveState(): Promise<Uint8Array> {
    const media = this.media;
    if (!media) throw new Error('Insert a disc first.');
    const info: MediaInfo = { title: media.title };
    if (media.kind === 'disc') info.discId = media.id;
    else {
      info.exe = media.bytes;
      info.exeName = media.title;
    }
    return encodeSession({ machine: captureState(this.machine), media: info });
  }

  /** Restores a state; a disc state needs its disc in (states don't carry discs). */
  async loadState(bytes: Uint8Array, loadExe: (bytes: Uint8Array, title: string) => LoadedMedia): Promise<void> {
    const session = await decodeSession(bytes);
    const wanted = session.media;
    if (wanted.discId) {
      if (this.media?.kind !== 'disc' || this.media.id !== wanted.discId) throw new Error(`That state is for ${wanted.title}: insert its disc first.`);
    } else if (wanted.exe) {
      this.media = loadExe(wanted.exe, wanted.exeName ?? wanted.title);
      this.machine.insertDisc(null);
    }
    restoreState(this.machine, session.machine);
    this.machine.setExe(null);
    this.clockDebt = 0;
  }
}
