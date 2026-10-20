import { Irq, type Interrupts } from '../irq';
import { TimedEvent, type Scheduler } from '../scheduler';
import { MemoryCard } from './memory-card';
import { Pad } from './pad';

const CTRL_TX_ENABLE = 1 << 0;
const CTRL_SELECT = 1 << 1;
const CTRL_ACKNOWLEDGE = 1 << 4;
const CTRL_RESET = 1 << 6;
const CTRL_ACK_IRQ = 1 << 12;
const CTRL_PORT2 = 1 << 13;

const STAT_TX_READY = 1 << 0;
const STAT_RX_READY = 1 << 1;
const STAT_TX_DONE = 1 << 2;
const STAT_ACK_LOW = 1 << 7;
const STAT_IRQ = 1 << 9;

/** How long after a byte the device pulls /ACK low, and for how long. */
const ACK_DELAY = 170;
const ACK_LENGTH = 100;

/**
 * SIO0, the controller and memory card port. The CPU selects port 1 or 2,
 * then exchanges bytes; each device answers a byte while receiving one and
 * pulses /ACK (raising IRQ7) when it wants another.
 */
export class Sio {
  readonly pads = [new Pad(), new Pad()];
  readonly cards = [new MemoryCard(), new MemoryCard()];
  /** Which device in the selected port is answering this transfer. */
  private device: 'none' | 'pad' | 'card' | 'unknown' = 'none';
  mode = 0;
  ctrl = 0;
  baud = 0;
  private rx = 0xff;
  private rxReady = false;
  private transferring = false;
  private ackLow = false;
  private irqFlag = false;
  private pendingReply = 0xff;
  private pendingAck = false;
  private readonly transferEvent: TimedEvent;
  private readonly ackEvent: TimedEvent;
  private readonly ackEndEvent: TimedEvent;

  constructor(
    private readonly sched: Scheduler,
    private readonly irq: Interrupts,
  ) {
    this.transferEvent = sched.add(new TimedEvent('sio-transfer', () => this.transferDone()));
    this.ackEvent = sched.add(new TimedEvent('sio-ack', () => this.ackStart()));
    this.ackEndEvent = sched.add(new TimedEvent('sio-ack-end', () => (this.ackLow = false)));
  }

  reset(): void {
    this.mode = this.ctrl = this.baud = 0;
    this.resetState();
    for (const pad of this.pads) pad.reset();
    for (const card of this.cards) card.reset();
  }

  private resetState(): void {
    this.rx = 0xff;
    this.rxReady = this.transferring = this.ackLow = this.irqFlag = false;
    this.device = 'none';
    this.sched.cancel(this.transferEvent);
    this.sched.cancel(this.ackEvent);
    this.sched.cancel(this.ackEndEvent);
  }

  private get port(): number {
    return this.ctrl & CTRL_PORT2 ? 1 : 0;
  }

  /** Cycles to shift a byte out at the current baud rate. */
  private byteCycles(): number {
    const factor = [1, 1, 16, 64][this.mode & 3];
    return Math.max(64, (this.baud || 0x88) * factor * 8);
  }

  read(offset: number): number {
    switch (offset) {
      case 0x0: {
        const value = this.rx;
        this.rxReady = false;
        this.rx = 0xff;
        return value | (value << 8) | (value << 16) | (value << 24);
      }
      case 0x4: {
        let stat = STAT_TX_READY;
        if (!this.transferring) stat |= STAT_TX_DONE;
        if (this.rxReady) stat |= STAT_RX_READY;
        if (this.ackLow) stat |= STAT_ACK_LOW;
        if (this.irqFlag) stat |= STAT_IRQ;
        return stat;
      }
      case 0x8:
        return this.mode;
      case 0xa:
        return this.ctrl;
      case 0xe:
        return this.baud;
      default:
        return 0;
    }
  }

  write(offset: number, value: number): void {
    switch (offset) {
      case 0x0:
        this.send(value & 0xff);
        return;
      case 0x8:
        this.mode = value & 0xffff;
        return;
      case 0xa:
        this.writeCtrl(value & 0xffff);
        return;
      case 0xe:
        this.baud = value & 0xffff;
        return;
    }
  }

  private writeCtrl(value: number): void {
    if (value & CTRL_RESET) {
      this.ctrl = 0;
      this.mode = 0;
      this.resetState();
      this.deselectAll();
      return;
    }
    if (value & CTRL_ACKNOWLEDGE) this.irqFlag = false;
    const wasSelected = (this.ctrl & CTRL_SELECT) !== 0;
    const portChanged = ((this.ctrl ^ value) & CTRL_PORT2) !== 0;
    this.ctrl = value & ~CTRL_ACKNOWLEDGE;
    if (!(value & CTRL_SELECT) || portChanged || !wasSelected) {
      this.deselectAll();
      this.device = 'none';
    }
  }

  private deselectAll(): void {
    for (const pad of this.pads) pad.deselect();
    for (const card of this.cards) card.deselect();
  }

  private send(value: number): void {
    if (!(this.ctrl & CTRL_TX_ENABLE) || !(this.ctrl & CTRL_SELECT)) {
      this.pendingReply = 0xff;
      this.pendingAck = false;
    } else {
      const port = this.port;
      if (this.device === 'none') this.device = value === 0x01 ? 'pad' : value === 0x81 ? 'card' : 'unknown';
      let result = { reply: 0xff, ack: false };
      if (this.device === 'pad') result = this.pads[port].transfer(value);
      else if (this.device === 'card') result = this.cards[port].transfer(value);
      this.pendingReply = result.reply;
      this.pendingAck = result.ack;
    }
    this.transferring = true;
    this.sched.schedule(this.transferEvent, this.byteCycles());
  }

  private transferDone(): void {
    this.transferring = false;
    this.rx = this.pendingReply;
    this.rxReady = true;
    if (this.pendingAck) this.sched.schedule(this.ackEvent, ACK_DELAY);
  }

  private ackStart(): void {
    this.ackLow = true;
    this.sched.schedule(this.ackEndEvent, ACK_LENGTH);
    if (this.ctrl & CTRL_ACK_IRQ && !this.irqFlag) {
      this.irqFlag = true;
      this.irq.raise(Irq.Sio0);
    }
  }
}
