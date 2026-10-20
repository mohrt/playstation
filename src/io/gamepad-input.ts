import { idlePad } from '../sio/pad';
import { PadButton, type PadState } from './controllers';

/** The parts of the browser's Gamepad object we use (so tests can pass plain objects). */
export interface GamepadLike {
  readonly id: string;
  readonly index: number;
  readonly mapping: string;
  readonly connected?: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value?: number }[];
}

const AXIS_THRESHOLD = 0.5;
/** Axes never go past ±1; a hat switch reads about 1.29 when centred. */
const HAT_NEUTRAL_LIMIT = 1.05;
/** Stick movement smaller than this reads as centred, so worn sticks don't drift. */
const STICK_DEAD_ZONE = 0.12;

// The standard gamepad mapping (https://w3c.github.io/gamepad/#remapping) is laid out
// like a DualShock: bottom, right, left and top face buttons are cross, circle, square
// and triangle; then the shoulders, triggers, Back/Select, Start and the stick clicks.
const DPAD = [
  [12, PadButton.Up],
  [13, PadButton.Down],
  [14, PadButton.Left],
  [15, PadButton.Right],
];
const BUTTONS: [number, number][] = [
  [0, PadButton.Cross],
  [1, PadButton.Circle],
  [2, PadButton.Square],
  [3, PadButton.Triangle],
  [4, PadButton.L1],
  [5, PadButton.R1],
  [6, PadButton.L2],
  [7, PadButton.R2],
  [8, PadButton.Select],
  [9, PadButton.Start],
  [10, PadButton.L3],
  [11, PadButton.R3],
];

const HAT_STEPS = [
  PadButton.Up,
  PadButton.Up | PadButton.Right,
  PadButton.Right,
  PadButton.Down | PadButton.Right,
  PadButton.Down,
  PadButton.Down | PadButton.Left,
  PadButton.Left,
  PadButton.Up | PadButton.Left,
];

/**
 * Directions of a hat switch reported as one axis: eight positions from -1
 * (up) clockwise in steps of 2/7, and a value beyond ±1 when centred. Many USB
 * pads report their D-pad this way when the browser has no standard mapping.
 */
export function hatDirections(value: number): number {
  if (Math.abs(value) > HAT_NEUTRAL_LIMIT) return 0;
  return HAT_STEPS[Math.round((value + 1) * 3.5)] ?? 0;
}

/** Axes seen resting beyond ±1, which makes them hat switches, by pad id. */
const knownHatAxes = new Map<string, Set<number>>();

function hatAxes(pad: GamepadLike): Set<number> {
  let hats = knownHatAxes.get(pad.id);
  if (!hats) {
    hats = new Set();
    knownHatAxes.set(pad.id, hats);
  }
  pad.axes.forEach((value, index) => {
    if (Math.abs(value) > HAT_NEUTRAL_LIMIT) hats.add(index);
  });
  return hats;
}

function axisPairDirs(x: number, y: number): number {
  let dirs = 0;
  if (y < -AXIS_THRESHOLD) dirs |= PadButton.Up;
  if (y > AXIS_THRESHOLD) dirs |= PadButton.Down;
  if (x < -AXIS_THRESHOLD) dirs |= PadButton.Left;
  if (x > AXIS_THRESHOLD) dirs |= PadButton.Right;
  return dirs;
}

/** A stick axis (-1..1) as the DualShock reports it: 0-255, 128 centred. */
function stick(value: number | undefined): number {
  const v = value ?? 0;
  if (Math.abs(v) < STICK_DEAD_ZONE) return 128;
  return Math.max(0, Math.min(255, Math.round(128 + v * 127.5)));
}

/** A pad as a DualShock: D-pad, face, shoulder and stick buttons, and both sticks. */
export function readGamepad(pad: GamepadLike): PadState {
  const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
  const axes = pad.axes;
  const state = idlePad();
  let buttons = 0;
  if (pad.mapping === 'standard') {
    for (const [index, button] of DPAD) if (pressed(index)) buttons |= button;
    state.leftX = stick(axes[0]);
    state.leftY = stick(axes[1]);
    state.rightX = stick(axes[2]);
    state.rightY = stick(axes[3]);
  } else {
    const hats = hatAxes(pad);
    if (!hats.has(0) && !hats.has(1)) buttons |= axisPairDirs(axes[0] ?? 0, axes[1] ?? 0);
    for (const index of hats) buttons |= hatDirections(axes[index] ?? 2);
  }
  for (const [index, button] of BUTTONS) if (pressed(index)) buttons |= button;
  state.buttons = buttons;
  return state;
}

/** Connected gamepads in the order they were plugged in; the first is player 1, the second player 2. */
export class GamepadManager {
  private readonly connectOrder: number[] = [];

  constructor(private readonly source: () => readonly (GamepadLike | null)[] = browserGamepads) {}

  attach(target: Window): void {
    target.addEventListener('gamepadconnected', (event) => this.noteConnected((event as GamepadEvent).gamepad.index));
    target.addEventListener('gamepaddisconnected', (event) => {
      const at = this.connectOrder.indexOf((event as GamepadEvent).gamepad.index);
      if (at >= 0) this.connectOrder.splice(at, 1);
    });
  }

  private noteConnected(index: number): void {
    if (!this.connectOrder.includes(index)) this.connectOrder.push(index);
  }

  connected(): GamepadLike[] {
    const pads = [...this.source()].filter((pad): pad is GamepadLike => pad !== null && pad.connected !== false);
    for (const pad of pads) this.noteConnected(pad.index);
    const rank = (pad: GamepadLike) => this.connectOrder.indexOf(pad.index);
    return pads.sort((a, b) => rank(a) - rank(b));
  }
}

function browserGamepads(): readonly (GamepadLike | null)[] {
  try {
    return navigator.getGamepads?.() ?? [];
  } catch {
    // Blocked by a permissions policy.
    return [];
  }
}

/** A short, readable name for a pad (browsers add vendor and product codes). */
export function padName(pad: GamepadLike): string {
  return pad.id.replace(/\s*\(.*\)\s*$/, '').trim() || 'Gamepad';
}
