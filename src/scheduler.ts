/** CPU clock: 44.1 kHz × 768. */
export const CPU_HZ = 33_868_800;

/** A device's timed event: fires once `now` reaches `time`, then must be scheduled again if needed. */
export class TimedEvent {
  time = Infinity;

  constructor(
    readonly name: string,
    readonly fire: () => void,
  ) {}
}

/**
 * The machine's clock, counted in CPU cycles, and the events devices are waiting for.
 * The CPU runs until `limit` (the next event or the end of its slice), so events
 * scheduled while it runs (by an I/O write) cut its slice short.
 */
export class Scheduler {
  now = 0;
  /** The CPU stops at this cycle to let events fire. */
  limit = 0;
  private sliceEnd = 0;
  private readonly events: TimedEvent[] = [];

  add(event: TimedEvent): TimedEvent {
    this.events.push(event);
    return event;
  }

  /** Fires `event` `delay` cycles from now (rescheduling it if it was already waiting). */
  schedule(event: TimedEvent, delay: number): void {
    event.time = this.now + Math.max(0, delay);
    if (event.time < this.limit) this.limit = event.time;
  }

  cancel(event: TimedEvent): void {
    event.time = Infinity;
  }

  reset(): void {
    this.now = 0;
    for (const event of this.events) event.time = Infinity;
    this.limit = this.sliceEnd = 0;
  }

  /** Starts a slice of CPU time ending at `end`, or earlier for an event. */
  beginSlice(end: number): void {
    this.sliceEnd = end;
    this.updateLimit();
  }

  private updateLimit(): void {
    let limit = this.sliceEnd;
    for (const event of this.events) if (event.time < limit) limit = event.time;
    this.limit = limit;
  }

  /** Fires every event that is due, in time order. */
  runDue(): void {
    for (;;) {
      let next: TimedEvent | null = null;
      for (const event of this.events) if (event.time <= this.now && (!next || event.time < next.time)) next = event;
      if (!next) break;
      next.time = Infinity;
      next.fire();
    }
    this.updateLimit();
  }
}
