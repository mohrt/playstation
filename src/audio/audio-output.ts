import workletUrl from './player-worklet.ts?worker&url';

/** The SPU's own rate; asked for so no resampling is needed (browsers may give another). */
const PREFERRED_RATE = 44100;

/**
 * Sends emulator audio to the speakers through an AudioWorklet. The worker
 * posts samples straight to the worklet over `port`. Browsers only allow audio
 * to start after a user gesture, so playback begins on the first click, tap
 * or key press.
 */
export class AudioOutput {
  private readonly gain: GainNode;

  private constructor(
    private readonly context: AudioContext,
    private readonly node: AudioWorkletNode,
    /** The end of the channel the worker sends samples on. */
    readonly port: MessagePort,
  ) {
    this.gain = context.createGain();
    node.connect(this.gain).connect(context.destination);
  }

  static async create(): Promise<AudioOutput> {
    let context: AudioContext;
    try {
      context = new AudioContext({ latencyHint: 'interactive', sampleRate: PREFERRED_RATE });
    } catch {
      context = new AudioContext({ latencyHint: 'interactive' });
    }
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, 'sample-player', { outputChannelCount: [2] });
    const channel = new MessageChannel();
    node.port.postMessage({ port: channel.port2 }, [channel.port2]);
    return new AudioOutput(context, node, channel.port1);
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  /** True once the browser has let audio start. */
  get running(): boolean {
    return this.context.state === 'running';
  }

  /** Resumes playback on the first user gesture; calls `onStart` once it is running. */
  resumeOnGesture(target: Window, onStart: () => void): void {
    const resume = () => {
      void this.context.resume().then(() => {
        if (!this.running) return;
        target.removeEventListener('pointerdown', resume);
        target.removeEventListener('keydown', resume);
        onStart();
      });
    };
    target.addEventListener('pointerdown', resume);
    target.addEventListener('keydown', resume);
  }

  setVolume(volume: number): void {
    this.gain.gain.value = volume;
  }

  /** Drops queued audio, e.g. after pausing. */
  flush(): void {
    this.node.port.postMessage('flush');
  }
}
