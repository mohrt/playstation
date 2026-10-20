import { PadButton, type ControllerInput } from './controllers';

const BUTTON_KEYS: Record<string, number> = {
  ArrowUp: PadButton.Up,
  ArrowDown: PadButton.Down,
  ArrowLeft: PadButton.Left,
  ArrowRight: PadButton.Right,
  KeyX: PadButton.Cross,
  KeyC: PadButton.Circle,
  KeyZ: PadButton.Square,
  KeyS: PadButton.Triangle,
  KeyQ: PadButton.L1,
  KeyE: PadButton.R1,
  Digit1: PadButton.L2,
  Digit3: PadButton.R2,
  Enter: PadButton.Start,
  ShiftRight: PadButton.Select,
  Backspace: PadButton.Select,
};
const PAUSE_KEYS = new Set(['Pause', 'KeyP']);
const FAST_FORWARD_KEYS = new Set(['Tab', 'Space']);

export interface KeyboardCallbacks {
  onPause(): void;
  onFastForward(held: boolean): void;
}

/** True when a key press belongs to a form field rather than the game. */
function typingInField(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

/**
 * Player 1 on the keyboard: arrows for the D-pad, the face buttons on S
 * (triangle), Z (square), X (cross) and C (circle), Q and E for L1 and R1, 1
 * and 3 for L2 and R2, Enter for Start and right Shift (or Backspace) for
 * Select. Holding Tab or Space fast-forwards; P pauses.
 */
export class KeyboardInput {
  private readonly held = new Set<string>();

  constructor(
    private readonly controller: ControllerInput,
    private readonly callbacks: KeyboardCallbacks,
  ) {}

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.onKey(event, true));
    target.addEventListener('keyup', (event) => this.onKey(event, false));
    target.addEventListener('blur', () => {
      this.held.clear();
      this.update();
      this.callbacks.onFastForward(false);
    });
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (down && (event.ctrlKey || event.metaKey || event.altKey || typingInField(event))) return;
    const code = event.code;
    if (PAUSE_KEYS.has(code)) {
      if (down && !event.repeat) this.callbacks.onPause();
      event.preventDefault();
      return;
    }
    if (FAST_FORWARD_KEYS.has(code)) {
      if (!event.repeat) this.callbacks.onFastForward(down);
      event.preventDefault();
      return;
    }
    if (!(code in BUTTON_KEYS)) return;
    event.preventDefault();
    if (down) this.held.add(code);
    else this.held.delete(code);
    this.update();
  }

  private update(): void {
    let buttons = 0;
    for (const code of this.held) buttons |= BUTTON_KEYS[code] ?? 0;
    this.controller.set('keyboard', { buttons });
  }
}
