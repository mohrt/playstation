import { Irq, type Interrupts } from './irq';
import { TimedEvent, type Scheduler } from './scheduler';

const MODE_SYNC = 1 << 0;
const MODE_RESET_AT_TARGET = 1 << 3;
const MODE_IRQ_TARGET = 1 << 4;
const MODE_IRQ_MAX = 1 << 5;
const MODE_IRQ_REPEAT = 1 << 6;
const MODE_IRQ_TOGGLE = 1 << 7;
const MODE_NO_IRQ = 1 << 10;
const MODE_REACHED_TARGET = 1 << 11;
const MODE_REACHED_MAX = 1 << 12;

class RootCounter {
  count = 0;
  mode = MODE_NO_IRQ;
  target = 0;
  /** Cycles counted towards the next tick. */
  pending = 0;
  /** One-shot interrupts fire once until the mode is written again. */
  irqDone = false;
  /** Waiting for a blank before counting (sync mode 3), or stopped by its sync mode. */
  waiting = false;

  constructor(readonly index: number) {}

  get syncMode(): number {
    return (this.mode >> 1) & 3;
  }

  get source(): number {
    return (this.mode >> 8) & 3;
  }
}

/**
 * The three root counters. Timer 0 counts the system clock or the GPU's dot
 * clock, timer 1 the system clock or horizontal blanks, timer 2 the system
 * clock or an eighth of it. Each can reset or pause on the blanks, and
 * interrupt on reaching its target or 0xFFFF.
 */
export class Timers {
  readonly counters = [new RootCounter(0), new RootCounter(1), new RootCounter(2)];
  private lastSync = 0;
  private inHblank = false;
  private inVblank = false;
  private readonly event: TimedEvent;
  /** CPU cycles per dot of the current video mode (for timer 0's dot clock). */
  dotCycles = 5;

  constructor(
    private readonly sched: Scheduler,
    private readonly irq: Interrupts,
  ) {
    this.event = sched.add(new TimedEvent('timers', () => this.syncAndSchedule()));
  }

  reset(): void {
    for (const t of this.counters) {
      t.count = t.target = t.pending = 0;
      t.mode = MODE_NO_IRQ;
      t.irqDone = t.waiting = false;
    }
    this.lastSync = this.sched.now;
    this.inHblank = this.inVblank = false;
    this.sched.cancel(this.event);
  }

  /** Cycles per tick, or 0 for timer 1 counting horizontal blanks. */
  private rate(t: RootCounter): number {
    if (t.index === 0) return t.source & 1 ? this.dotCycles : 1;
    if (t.index === 1) return t.source & 1 ? 0 : 1;
    return t.source & 2 ? 8 : 1;
  }

  private stopped(t: RootCounter): boolean {
    if (t.waiting) return true;
    if (!(t.mode & MODE_SYNC)) return false;
    const sync = t.syncMode;
    if (t.index === 2) return sync === 0 || sync === 3;
    const blank = t.index === 0 ? this.inHblank : this.inVblank;
    if (sync === 0) return blank;
    if (sync === 2) return !blank;
    return false;
  }

  /** Brings every counter up to the current cycle. */
  sync(): void {
    const elapsed = this.sched.now - this.lastSync;
    this.lastSync = this.sched.now;
    if (elapsed <= 0) return;
    for (const t of this.counters) {
      const rate = this.rate(t);
      if (rate === 0 || this.stopped(t)) continue;
      t.pending += elapsed;
      const ticks = Math.floor(t.pending / rate);
      if (ticks > 0) {
        t.pending -= ticks * rate;
        this.advance(t, ticks);
      }
    }
  }

  private advance(t: RootCounter, ticks: number): void {
    while (ticks > 0) {
      if (t.mode & MODE_RESET_AT_TARGET && t.count === t.target) {
        t.count = 0;
        ticks--;
        continue;
      }
      if (t.count === 0xffff) {
        t.count = 0;
        ticks--;
        continue;
      }
      let toTarget = t.target - t.count;
      if (toTarget <= 0) toTarget += 0x10000;
      const step = Math.min(ticks, toTarget, 0xffff - t.count);
      t.count += step;
      ticks -= step;
      if (t.count === t.target) {
        t.mode |= MODE_REACHED_TARGET;
        if (t.mode & MODE_IRQ_TARGET) this.interrupt(t);
      }
      if (t.count === 0xffff) {
        t.mode |= MODE_REACHED_MAX;
        if (t.mode & MODE_IRQ_MAX) this.interrupt(t);
      }
    }
  }

  private interrupt(t: RootCounter): void {
    if (!(t.mode & MODE_IRQ_REPEAT) && t.irqDone) return;
    t.irqDone = true;
    if (t.mode & MODE_IRQ_TOGGLE) {
      t.mode ^= MODE_NO_IRQ;
      if (t.mode & MODE_NO_IRQ) return;
    } else {
      t.mode &= ~MODE_NO_IRQ;
    }
    this.irq.raise(Irq.Timer0 + t.index);
    // In pulse mode the request line goes straight back up.
    if (!(t.mode & MODE_IRQ_TOGGLE)) t.mode |= MODE_NO_IRQ;
  }

  private syncAndSchedule(): void {
    this.sync();
    this.schedule();
  }

  /** Wakes up when a counter next reaches a value it interrupts on. */
  private schedule(): void {
    let soonest = Infinity;
    for (const t of this.counters) {
      if (!(t.mode & (MODE_IRQ_TARGET | MODE_IRQ_MAX))) continue;
      if (!(t.mode & MODE_IRQ_REPEAT) && t.irqDone) continue;
      const rate = this.rate(t);
      if (rate === 0 || this.stopped(t)) continue;
      let ticks = 0x10000 - t.count;
      if (t.mode & MODE_IRQ_TARGET) {
        let toTarget = t.target - t.count;
        if (toTarget <= 0) toTarget += t.mode & MODE_RESET_AT_TARGET ? t.target + 1 : 0x10000;
        ticks = Math.min(ticks, toTarget);
      }
      if (t.mode & MODE_IRQ_MAX) ticks = Math.min(ticks, 0xffff - t.count || 0x10000);
      soonest = Math.min(soonest, Math.max(1, Math.ceil(ticks * rate - t.pending)));
    }
    if (soonest === Infinity) this.sched.cancel(this.event);
    else this.sched.schedule(this.event, soonest);
  }

  read(offset: number): number {
    const t = this.counters[(offset >> 4) & 3];
    if (!t) return 0;
    this.sync();
    switch (offset & 0xc) {
      case 0x0:
        return t.count;
      case 0x4: {
        const mode = t.mode;
        t.mode &= ~(MODE_REACHED_TARGET | MODE_REACHED_MAX);
        return mode;
      }
      case 0x8:
        return t.target;
      default:
        return 0;
    }
  }

  write(offset: number, value: number): void {
    const t = this.counters[(offset >> 4) & 3];
    if (!t) return;
    this.sync();
    switch (offset & 0xc) {
      case 0x0:
        t.count = value & 0xffff;
        break;
      case 0x4:
        t.mode = (value & 0x3ff) | MODE_NO_IRQ;
        t.count = 0;
        t.pending = 0;
        t.irqDone = false;
        t.waiting = (t.mode & MODE_SYNC) !== 0 && t.index !== 2 && t.syncMode === 3;
        break;
      case 0x8:
        t.target = value & 0xffff;
        break;
    }
    this.schedule();
  }

  /** The GPU's horizontal blank: timer 1 may count it, timer 0 may reset on it. */
  hblank(): void {
    this.sync();
    this.inHblank = true;
    const t0 = this.counters[0];
    if (t0.mode & MODE_SYNC) {
      if (t0.syncMode === 1 || t0.syncMode === 2) t0.count = 0;
      if (t0.syncMode === 3) t0.waiting = false;
    }
    const t1 = this.counters[1];
    if (t1.source & 1 && !this.stopped(t1)) this.advance(t1, 1);
    this.inHblank = false;
    this.schedule();
  }

  vblank(start: boolean): void {
    this.sync();
    this.inVblank = start;
    const t1 = this.counters[1];
    if (start && t1.mode & MODE_SYNC) {
      if (t1.syncMode === 1 || t1.syncMode === 2) t1.count = 0;
      if (t1.syncMode === 3) t1.waiting = false;
    }
    this.schedule();
  }
}
