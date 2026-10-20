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

export type PadType = 'digital' | 'dualshock';

/** What a player is pressing: buttons and, on a DualShock, the sticks (0-255, 128 centred). */
export interface PadState {
  buttons: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

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
  state: PadState = idlePad();

  reset(): void {
    this.config = false;
    this.analog = this.type === 'dualshock' && this.analog;
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
    } else if (position === 3) {
      this.parameter(value);
    }
    const index = position - 1;
    if (index >= this.response.length) return { reply: 0xff, ack: false };
    this.acking = index < this.response.length - 1;
    return { reply: this.response[index], ack: this.acking };
  }

  private id(): number {
    if (this.config) return 0xf3;
    return this.analog ? 0x73 : 0x41;
  }

  private report(): number[] {
    const buttons = ~this.state.buttons & 0xffff;
    const bytes = [buttons & 0xff, buttons >> 8];
    if (this.analog || this.config) bytes.push(this.state.rightX, this.state.rightY, this.state.leftX, this.state.leftY);
    return bytes;
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
        return [0xf3, 0x5a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
      default:
        return [0xf3, 0x5a, 0, 0, 0, 0, 0, 0];
    }
  }

  /** The first parameter byte, which some commands' replies depend on. */
  private parameter(value: number): void {
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
