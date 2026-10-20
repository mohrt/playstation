/** Pad buttons, as bits of the pad's 16-bit report (the pad sends them inverted: 0 = pressed). */
export const PadButton = {
  Select: 1 << 0,
  L3: 1 << 1,
  R3: 1 << 2,
  Start: 1 << 3,
  Up: 1 << 4,
  Right: 1 << 5,
  Down: 1 << 6,
  Left: 1 << 7,
  L2: 1 << 8,
  R2: 1 << 9,
  L1: 1 << 10,
  R1: 1 << 11,
  Triangle: 1 << 12,
  Circle: 1 << 13,
  Cross: 1 << 14,
  Square: 1 << 15,
} as const;

export type PadType = 'digital' | 'dualshock' | 'guncon' | 'mouse';

/** What a player is pressing: buttons and, on a DualShock, the sticks (0-255, 128 centred). */
export interface PadState {
  buttons: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  /** Where a light gun points: 0-1 across and down the picture, or null when it points off the screen. */
  aim?: { x: number; y: number } | null;
}

/** The GunCon's buttons, in the bits a pad reports Start, circle and cross in. */
export const GunButton = { A: PadButton.Start, Trigger: PadButton.Circle, B: PadButton.Cross } as const;
/** The PlayStation Mouse's buttons, in the bits a pad reports L1 and R1 in. */
export const MouseButton = { Right: PadButton.L1, Left: PadButton.R1 } as const;
/** What the GunCon reports when it sees no picture. */
const GUN_OFF_SCREEN = { x: 0x0001, y: 0x000a };

export const idlePad = (): PadState => ({ buttons: 0, leftX: 128, leftY: 128, rightX: 128, rightY: 128 });

/**
 * A controller on the serial bus. A transfer starts with 01h; the next byte is
 * the command (42h reads the buttons). A DualShock also answers configuration
 * commands (43h-4Dh) and can be switched between digital and analog mode.
 */
export class Pad {
  type: PadType = 'digital';
  analog = false;
  private config = false;
  private response: number[] = [];
  private position = 0;
  private command = 0;
  /** Whether the pad drives /ACK after a byte (every byte but the last). */
  private acking = false;
  /** Which motor each of the 42h command's six parameter bytes drives (set with 4Dh): 00h small, 01h large, FFh none. */
  private rumbleMap = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  /** The DualShock's motors: the small one is on or off (0 or 255), the large one has a speed (0-255). */
  smallMotor = 0;
  largeMotor = 0;
  state: PadState = idlePad();
  /** Converts a light gun's aim (0-1 across the picture) to the beam position it would see (set by the console). */
  beamAt: ((x: number, y: number) => { x: number; y: number }) | null = null;
  /** Mouse movement not yet reported. */
  private motionX = 0;
  private motionY = 0;

  /** Adds mouse movement, reported (128 counts at most per axis) at the next polls. */
  move(dx: number, dy: number): void {
    this.motionX += dx;
    this.motionY += dy;
  }

  reset(): void {
    this.config = false;
    this.analog = this.type === 'dualshock' && this.analog;
    this.rumbleMap.fill(0xff);
    this.smallMotor = this.largeMotor = 0;
    this.motionX = this.motionY = 0;
    this.deselect();
  }

  deselect(): void {
    this.position = 0;
    this.response = [];
    this.acking = false;
  }

  /** Exchanges one byte; returns the reply and whether the pad acknowledges it. */
  transfer(value: number): { reply: number; ack: boolean } {
    const position = this.position++;
    if (position === 0) {
      if (value !== 0x01) {
        this.position = Infinity;
        return { reply: 0xff, ack: false };
      }
      return { reply: 0xff, ack: true };
    }
    if (position === 1) {
      this.command = value;
      this.response = this.respond(value);
    } else if (position >= 3) {
      this.parameter(value, position - 3);
    }
    const index = position - 1;
    if (index >= this.response.length) return { reply: 0xff, ack: false };
    this.acking = index < this.response.length - 1;
    return { reply: this.response[index], ack: this.acking };
  }

  private id(): number {
    if (this.type === 'guncon') return 0x63;
    if (this.type === 'mouse') return 0x12;
    if (this.config) return 0xf3;
    return this.analog ? 0x73 : 0x41;
  }

  private report(): number[] {
    if (this.type === 'guncon') return this.gunReport();
    if (this.type === 'mouse') return this.mouseReport();
    const buttons = ~this.state.buttons & 0xffff;
    const bytes = [buttons & 0xff, buttons >> 8];
    if (this.analog || this.config) bytes.push(this.state.rightX, this.state.rightY, this.state.leftX, this.state.leftY);
    return bytes;
  }

  /** The pad's whole reply to `command` (its ID first), as the Multitap collects it from each slot. */
  poll(command: number): number[] {
    return this.respond(command);
  }

  /** Trigger, A and B, then where the gun sees the beam: X in 8 MHz ticks into the line, Y in lines. */
  private gunReport(): number[] {
    const buttons = ~(this.state.buttons & (GunButton.A | GunButton.Trigger | GunButton.B)) & 0xffff;
    const aim = this.state.aim;
    const { x, y } = aim && this.beamAt ? this.beamAt(aim.x, aim.y) : GUN_OFF_SCREEN;
    return [buttons & 0xff, buttons >> 8, x & 0xff, (x >> 8) & 0xff, y & 0xff, (y >> 8) & 0xff];
  }

  /** The two buttons, then the movement since the last poll (signed, at most 128 counts). */
  private mouseReport(): number[] {
    const buttons = ~(this.state.buttons & (MouseButton.Left | MouseButton.Right)) & 0xffff;
    const dx = Math.max(-128, Math.min(127, Math.round(this.motionX)));
    const dy = Math.max(-128, Math.min(127, Math.round(this.motionY)));
    this.motionX -= dx;
    this.motionY -= dy;
    return [buttons & 0xff, buttons >> 8, dx & 0xff, dy & 0xff];
  }

  /** The reply to a command, starting with the pad's ID byte. */
  private respond(command: number): number[] {
    const dualshock = this.type === 'dualshock';
    if (command === 0x42) return [this.id(), 0x5a, ...this.report()];
    if (!dualshock) return [];
    if (command === 0x43) return [this.id(), 0x5a, ...(this.config ? [0, 0, 0, 0, 0, 0] : this.report())];
    if (!this.config) return [];
    switch (command) {
      case 0x44:
        return [0xf3, 0x5a, 0, 0, 0, 0, 0, 0];
      case 0x45:
        return [0xf3, 0x5a, 0x03, 0x02, this.analog ? 1 : 0, 0x02, 0x01, 0x00];
      case 0x46:
        return [0xf3, 0x5a, 0x00, 0x00, 0x01, 0x02, 0x00, 0x0a];
      case 0x47:
        return [0xf3, 0x5a, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00];
      case 0x4c:
        return [0xf3, 0x5a, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00];
      case 0x4d:
        return [0xf3, 0x5a, ...this.rumbleMap];
      default:
        return [0xf3, 0x5a, 0, 0, 0, 0, 0, 0];
    }
  }

  /** A parameter byte (`index` 0 is the first): some commands' replies depend on the first, and 42h and 4Dh use all six for the motors. */
  private parameter(value: number, index: number): void {
    if (this.type === 'dualshock' && index < 6) {
      if (this.command === 0x42) {
        if (this.rumbleMap[index] === 0x00) this.smallMotor = value & 0x01 ? 0xff : 0;
        else if (this.rumbleMap[index] === 0x01) this.largeMotor = value;
      } else if (this.command === 0x4d && this.config) {
        this.rumbleMap[index] = value;
      }
    }
    if (index !== 0) return;
    switch (this.command) {
      case 0x43:
        // Entering or leaving configuration takes effect after this transfer's reply was chosen.
        this.config = value === 0x01;
        break;
      case 0x44:
        this.analog = value === 0x01;
        break;
      case 0x46:
        if (value === 0x01) this.response = [0xf3, 0x5a, 0x00, 0x00, 0x01, 0x01, 0x01, 0x14];
        break;
      case 0x4c:
        if (value === 0x01) this.response = [0xf3, 0x5a, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00];
        break;
    }
  }
}
