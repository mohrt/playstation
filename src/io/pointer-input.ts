import { GunButton, MouseButton, type PadType } from '../sio/pad';
import type { ControllerInput } from './controllers';

const SOURCE = 'pointer';

/**
 * The mouse (or a finger) on the screen, as the first port's GunCon or PlayStation
 * Mouse. The GunCon points where the mouse is: left button is the trigger, right
 * is A and middle is B, and Shift-click shoots off the screen (to reload). The
 * Mouse captures the pointer when the screen is clicked; Esc lets it go.
 */
export class PointerInput {
  private port = -1;
  private type: PadType = 'digital';
  private aim: { x: number; y: number } | null = null;
  private buttons = 0;
  private offScreen = false;
  private motionX = 0;
  private motionY = 0;

  constructor(
    private readonly screen: HTMLElement,
    private readonly controllers: ControllerInput[],
  ) {
    screen.addEventListener('pointermove', (event) => this.moved(event));
    screen.addEventListener('pointerleave', () => {
      if (this.type !== 'guncon') return;
      this.aim = null;
      this.update();
    });
    screen.addEventListener('pointerdown', (event) => this.pressed(event));
    window.addEventListener('pointerup', (event) => this.released(event));
    screen.addEventListener('contextmenu', (event) => {
      if (this.port >= 0) event.preventDefault();
    });
  }

  /** Follows the first port that has a GunCon or a mouse in it. */
  setPadTypes(types: readonly PadType[]): void {
    if (this.port >= 0) this.controllers[this.port].clear(SOURCE);
    this.port = types.findIndex((type) => type === 'guncon' || type === 'mouse');
    this.type = this.port >= 0 ? types[this.port] : 'digital';
    this.buttons = this.motionX = this.motionY = 0;
    this.screen.classList.toggle('aiming', this.type === 'guncon');
    if (this.type !== 'mouse' && this.locked) document.exitPointerLock();
    this.update();
  }

  /** Mouse movement since last asked, for the port the mouse is in. */
  takeMotion(): { port: number; dx: number; dy: number } | null {
    if (this.type !== 'mouse' || (this.motionX === 0 && this.motionY === 0)) return null;
    const motion = { port: this.port, dx: this.motionX, dy: this.motionY };
    this.motionX = this.motionY = 0;
    return motion;
  }

  private get locked(): boolean {
    return document.pointerLockElement === this.screen;
  }

  private moved(event: PointerEvent): void {
    if (this.type === 'guncon') {
      this.aimAt(event);
      this.update();
    } else if (this.type === 'mouse' && this.locked) {
      this.motionX += event.movementX;
      this.motionY += event.movementY;
    }
  }

  private pressed(event: PointerEvent): void {
    if (this.port < 0) return;
    if (this.type === 'mouse' && !this.locked) {
      // A promise in newer browsers (refused if the page isn't allowed to capture the pointer).
      const request = this.screen.requestPointerLock?.() as Promise<void> | undefined;
      request?.catch(() => {});
      return;
    }
    const button = this.buttonFor(event.button);
    if (!button) return;
    event.preventDefault();
    if (this.type === 'guncon') {
      this.aimAt(event);
      if (button === GunButton.Trigger && event.shiftKey) this.offScreen = true;
    }
    this.buttons |= button;
    this.update();
  }

  private released(event: PointerEvent): void {
    const button = this.buttonFor(event.button);
    if (!button || !(this.buttons & button)) return;
    this.buttons &= ~button;
    if (button === GunButton.Trigger) this.offScreen = false;
    this.update();
  }

  private buttonFor(mouseButton: number): number {
    if (this.type === 'guncon') return [GunButton.Trigger, GunButton.B, GunButton.A][mouseButton] ?? 0;
    if (this.type === 'mouse') return [MouseButton.Left, 0, MouseButton.Right][mouseButton] ?? 0;
    return 0;
  }

  private aimAt(event: PointerEvent): void {
    const box = this.screen.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    this.aim = x >= 0 && x < 1 && y >= 0 && y < 1 ? { x, y } : null;
  }

  private update(): void {
    if (this.port < 0) return;
    const aim = this.type === 'guncon' ? (this.offScreen ? null : this.aim) : undefined;
    this.controllers[this.port].set(SOURCE, { buttons: this.buttons, aim });
  }
}
