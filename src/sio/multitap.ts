import { Pad } from './pad';

/** What a slot-A access returns, decided by the access before it (see `startAccess`). */
type TapReply = 'slot-a' | 'all-slots' | 'garbage';

const BYTES_PER_SLOT = 8;

/**
 * The SCPH-1070 Multitap: four controllers on one port. Addressing a transfer to
 * 01h-04h talks to slot A-D's pad directly; or a TAP byte of 01h in a slot-A read
 * asks for the next slot-A read to return all four pads at once, after the
 * multitap's own ID (80h): 8 bytes per slot, padded with FFh.
 */
export class Multitap {
  plugged = false;
  /** Slots B-D (slot A is the port's own pad). */
  readonly pads = [new Pad(), new Pad(), new Pad()];
  /** Whether the last slot-A access asked for all slots (its TAP byte was 01h). */
  private requested = false;
  private lastReply: TapReply = 'slot-a';
  private reply: TapReply = 'slot-a';
  private slot = -1;
  private position = 0;
  private response: number[] = [];

  constructor(private readonly slotA: Pad) {
    for (const pad of this.pads) pad.type = 'dualshock';
  }

  /** The pads in slots A-D. */
  get slots(): Pad[] {
    return [this.slotA, ...this.pads];
  }

  reset(): void {
    for (const pad of this.pads) pad.reset();
    this.requested = false;
    this.lastReply = 'slot-a';
    this.deselect();
  }

  deselect(): void {
    this.slot = -1;
    this.position = 0;
    this.response = [];
    for (const pad of this.pads) pad.deselect();
  }

  /** Exchanges one byte; the first is the address (01h-04h for the pad in slot A-D). */
  transfer(value: number): { reply: number; ack: boolean } {
    const position = this.position++;
    if (position === 0) return this.startAccess(value);
    if (this.slot < 0) return { reply: 0xff, ack: false };
    if (this.slot > 0) return this.slots[this.slot].transfer(value);
    if (position === 2 && value === 0x01) this.requested = true;
    if (this.reply === 'slot-a') return this.slotA.transfer(value);
    if (position === 1) this.response = this.longReply(value);
    const index = position - 1;
    if (index >= this.response.length) return { reply: 0xff, ack: false };
    return { reply: this.response[index], ack: index < this.response.length - 1 };
  }

  private startAccess(address: number): { reply: number; ack: boolean } {
    if (address < 0x01 || address > 0x04) return { reply: 0xff, ack: false };
    this.slot = address - 1;
    if (this.slot > 0) return this.slots[this.slot].transfer(0x01);
    // A request in the last slot-A read makes this one return every slot, or (right after doing that) garbage.
    this.reply = !this.requested ? 'slot-a' : this.lastReply === 'all-slots' ? 'garbage' : 'all-slots';
    this.lastReply = this.reply;
    this.requested = false;
    return this.slotA.transfer(0x01);
  }

  /** The multitap's ID and every slot's reply to `command` (or, as garbage, the ID and slot A's ID byte only). */
  private longReply(command: number): number[] {
    if (this.reply === 'garbage') return [0x80, 0x5a, this.slotA.poll(command)[0] ?? 0xff];
    const bytes = [0x80, 0x5a];
    for (const pad of this.slots) {
      const answer = pad.poll(command).slice(0, BYTES_PER_SLOT);
      bytes.push(...answer, ...new Array<number>(BYTES_PER_SLOT - answer.length).fill(0xff));
    }
    return bytes;
  }
}
