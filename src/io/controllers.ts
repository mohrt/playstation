import { idlePad, PadButton, type PadState } from '../sio/pad';

export { PadButton, type PadState };

/** One controller, pressed by several input sources (keyboard, gamepad, on-screen pad) at once. */
export class ControllerInput {
  private readonly sources = new Map<string, PadState>();
  /** Buttons pressed since the state was last read, so a tap shorter than a frame isn't lost. */
  private tapped = 0;

  set(source: string, state: Partial<PadState>): void {
    this.sources.set(source, { ...idlePad(), ...state });
    this.tapped |= state.buttons ?? 0;
  }

  clear(source: string): void {
    this.sources.delete(source);
  }

  /** Buttons from every source; each stick from whichever source moves it furthest. */
  get state(): PadState {
    const merged = idlePad();
    merged.buttons = this.tapped;
    this.tapped = 0;
    let leftDistance = 0;
    let rightDistance = 0;
    for (const state of this.sources.values()) {
      merged.buttons |= state.buttons;
      const left = Math.abs(state.leftX - 128) + Math.abs(state.leftY - 128);
      if (left > leftDistance) {
        leftDistance = left;
        merged.leftX = state.leftX;
        merged.leftY = state.leftY;
      }
      const right = Math.abs(state.rightX - 128) + Math.abs(state.rightY - 128);
      if (right > rightDistance) {
        rightDistance = right;
        merged.rightX = state.rightX;
        merged.rightY = state.rightY;
      }
    }
    // A D-pad can't press opposite directions together; some games misbehave if they see it.
    if ((merged.buttons & (PadButton.Up | PadButton.Down)) === (PadButton.Up | PadButton.Down)) merged.buttons &= ~(PadButton.Up | PadButton.Down);
    if ((merged.buttons & (PadButton.Left | PadButton.Right)) === (PadButton.Left | PadButton.Right)) merged.buttons &= ~(PadButton.Left | PadButton.Right);
    return merged;
  }
}
