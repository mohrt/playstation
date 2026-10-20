import type { PadState, PadType } from './sio/pad';

/** What the page tells the emulation worker. */
export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; audioPort: MessagePort | null; sampleRate: number; openBios: Uint8Array; userBios: Uint8Array | null; useUserBios: boolean; cards: (Uint8Array | null)[] }
  | { type: 'run'; elapsed: number; fastForward: boolean }
  | { type: 'pause'; paused: boolean }
  | { type: 'media'; files: File[]; title?: string }
  | { type: 'eject' }
  | { type: 'power' }
  | { type: 'reset' }
  | { type: 'pads'; pads: PadState[] }
  | { type: 'pad-types'; types: PadType[] }
  | { type: 'analog'; port: number }
  | { type: 'bios'; userBios: Uint8Array | null; useUserBios: boolean }
  | { type: 'memory-card'; slot: number; data: Uint8Array }
  | { type: 'save-state' }
  | { type: 'load-state'; bytes: Uint8Array }
  | { type: 'sound'; enabled: boolean };

/** The console's state, for the page's status line. */
export interface ConsoleStatus {
  title: string | null;
  kind: 'disc' | 'exe' | null;
  /** A line about what is in: serial, region, tracks. */
  details: string;
  bios: string;
  pads: { type: PadType; analog: boolean }[];
}

/** What the worker tells the page. */
export type FromWorker =
  | { type: 'ready' }
  /** A slice of time was run and shown; `speed` is how close to full speed the console keeps up. */
  | { type: 'frame'; speed: number }
  | { type: 'status'; status: ConsoleStatus }
  | { type: 'media-loaded'; title: string; details: string; kind: 'disc' | 'exe' }
  | { type: 'memory-card'; slot: number; data: Uint8Array }
  | { type: 'state'; bytes: Uint8Array; title: string }
  | { type: 'state-loaded' }
  | { type: 'tty'; text: string }
  | { type: 'error'; message: string; context: 'media' | 'state' | 'run' };
