import { describe, expect, it } from 'vitest';
import { RumbleOutput } from '../src/io/gamepad-input';
import { Irq } from '../src/irq';
import { PlayStation } from '../src/playstation';
import { formattedCard, MEMORY_CARD_SIZE } from '../src/sio/memory-card';
import { GunButton, idlePad, MouseButton, PadButton } from '../src/sio/pad';
import { readMemoryCardFile } from '../src/storage/memory-cards';

const JOY_DATA = 0x1f801040;
const JOY_STAT = 0x1f801044;
const JOY_CTRL = 0x1f80104a;
const JOY_BAUD = 0x1f80104e;

/** Talks to a port the way the BIOS does: select, then exchange bytes, waiting for each to arrive and be acknowledged. */
function exchange(machine: PlayStation, port: number, bytes: number[]): { replies: number[]; acks: boolean[] } {
  const bus = machine.bus;
  bus.write16(JOY_BAUD, 0x88);
  bus.write16(JOY_CTRL, 0x1003 | (port << 13)); // TX enable, select, ACK interrupt enable
  machine.irq.writeMask(1 << Irq.Sio0);
  const replies: number[] = [];
  const acks: boolean[] = [];
  for (const byte of bytes) {
    machine.irq.writeStat(0);
    bus.write16(JOY_CTRL, bus.read16(JOY_CTRL) | 0x10);
    bus.write8(JOY_DATA, byte);
    machine.run(1500);
    expect(bus.read16(JOY_STAT) & 2).toBe(2);
    replies.push(bus.read8(JOY_DATA));
    acks.push((machine.irq.stat & (1 << Irq.Sio0)) !== 0);
  }
  bus.write16(JOY_CTRL, 0);
  return { replies, acks };
}

function machine(): PlayStation {
  const m = new PlayStation();
  m.powerOn();
  return m;
}

describe('controllers and memory cards', () => {
  it('reads a digital pad: ID 41h, 5Ah, then the buttons (0 = pressed)', () => {
    const m = machine();
    m.sio.pads[0].state = { ...idlePad(), buttons: PadButton.Start | PadButton.Cross };
    const { replies, acks } = exchange(m, 0, [0x01, 0x42, 0, 0, 0]);
    expect(replies.slice(1)).toEqual([0x41, 0x5a, 0xf7, 0xbf]);
    expect(acks).toEqual([true, true, true, true, false]);
  });

  it('switches a DualShock to analog mode through its config commands', () => {
    const m = machine();
    const pad = m.sio.pads[0];
    pad.type = 'dualshock';
    pad.state = { ...idlePad(), leftX: 0, rightY: 255 };
    exchange(m, 0, [0x01, 0x43, 0x00, 0x01, 0x00]); // enter config
    exchange(m, 0, [0x01, 0x44, 0x00, 0x01, 0x03, 0, 0, 0, 0]); // analog, locked
    exchange(m, 0, [0x01, 0x43, 0x00, 0x00, 0x00, 0, 0, 0, 0]); // leave config
    const { replies } = exchange(m, 0, [0x01, 0x42, 0, 0, 0, 0, 0, 0, 0]);
    expect(replies[1]).toBe(0x73);
    expect(replies.slice(5)).toEqual([128, 255, 0, 128]);
  });

  it("runs a DualShock's motors from the bytes 4Dh maps them to", () => {
    const m = machine();
    const pad = m.sio.pads[0];
    pad.type = 'dualshock';
    exchange(m, 0, [0x01, 0x43, 0x00, 0x01, 0x00]); // enter config
    const { replies } = exchange(m, 0, [0x01, 0x4d, 0x00, 0x00, 0x01, 0xff, 0xff, 0xff, 0xff]); // small motor, then large
    expect(replies.slice(3)).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]); // the old mapping
    exchange(m, 0, [0x01, 0x43, 0x00, 0x00, 0x00, 0, 0, 0, 0]); // leave config
    exchange(m, 0, [0x01, 0x42, 0x00, 0x01, 0xc0]);
    expect([pad.smallMotor, pad.largeMotor]).toEqual([0xff, 0xc0]);
    exchange(m, 0, [0x01, 0x42, 0x00, 0x00, 0x00]);
    expect([pad.smallMotor, pad.largeMotor]).toEqual([0, 0]);
  });

  it('aims a GunCon: ID 63h, the trigger, then where the beam is (or 0001h, 000Ah off the screen)', () => {
    const m = machine();
    const pad = m.sio.pads[0];
    pad.type = 'guncon';
    pad.state = { ...idlePad(), buttons: GunButton.Trigger, aim: { x: 0.5, y: 0.5 } };
    const { replies } = exchange(m, 0, [0x01, 0x42, 0, 0, 0, 0, 0, 0, 0]);
    expect(replies.slice(1, 3)).toEqual([0x63, 0x5a]);
    expect((replies[3] | (replies[4] << 8)) & GunButton.Trigger).toBe(0);
    const x = replies[5] | (replies[6] << 8);
    const y = replies[7] | (replies[8] << 8);
    expect({ x, y }).toEqual(m.gpu.lightGunPosition(0.5, 0.5));
    expect(x).toBeGreaterThan(200);
    expect(x).toBeLessThan(340);
    expect(y).toBe(0x10 + 120);
    pad.state = { ...idlePad(), aim: null };
    const off = exchange(m, 0, [0x01, 0x42, 0, 0, 0, 0, 0, 0, 0]).replies;
    expect(off.slice(5)).toEqual([0x01, 0x00, 0x0a, 0x00]);
  });

  it('reports PlayStation Mouse movement 128 counts at most per poll', () => {
    const m = machine();
    const pad = m.sio.pads[0];
    pad.type = 'mouse';
    pad.state = { ...idlePad(), buttons: MouseButton.Left };
    pad.move(300, -5);
    const polls = [0, 1, 2].map(() => exchange(m, 0, [0x01, 0x42, 0, 0, 0, 0, 0]).replies);
    expect(polls[0].slice(1, 3)).toEqual([0x12, 0x5a]);
    expect(((polls[0][3] | (polls[0][4] << 8)) & MouseButton.Left) === 0).toBe(true);
    const signed = (byte: number) => (byte << 24) >> 24;
    expect(polls.map((reply) => [signed(reply[5]), signed(reply[6])])).toEqual([
      [127, -5],
      [127, 0],
      [46, 0],
    ]);
  });

  it('replays rumble on a gamepad while the motors run, and stops it after', () => {
    const effects: string[] = [];
    const gamepad = {
      id: 'pad',
      index: 0,
      mapping: 'standard',
      axes: [],
      buttons: [],
      vibrationActuator: {
        playEffect: (_type: string, params: { strongMagnitude: number; weakMagnitude: number }) => {
          effects.push(`${params.strongMagnitude}/${params.weakMagnitude}`);
          return Promise.resolve('complete');
        },
        reset: () => {
          effects.push('reset');
          return Promise.resolve('complete');
        },
      },
    };
    const output = new RumbleOutput();
    output.update(gamepad, { strong: 0.5, weak: 1 }, 0);
    output.update(gamepad, { strong: 0.5, weak: 1 }, 50);
    output.update(gamepad, { strong: 0.5, weak: 1 }, 120);
    output.update(gamepad, { strong: 0, weak: 0 }, 130);
    output.update(gamepad, { strong: 0, weak: 0 }, 140);
    expect(effects).toEqual(['0.5/1', '0.5/1', 'reset']);
  });

  it('leaves a port with nothing answering unacknowledged', () => {
    const m = machine();
    const { replies, acks } = exchange(m, 1, [0x99]);
    expect(replies).toEqual([0xff]);
    expect(acks).toEqual([false]);
  });

  it('writes and reads back a memory card sector', () => {
    const m = machine();
    const data = Array.from({ length: 128 }, (_, i) => (i * 7) & 0xff);
    const checksum = data.reduce((x, b) => x ^ b, 0x00 ^ 0x45);
    const write = exchange(m, 0, [0x81, 0x57, 0, 0, 0x00, 0x45, ...data, checksum, 0, 0, 0]);
    expect(write.replies[1]).toBe(0x08); // a fresh card reports "not written yet"
    expect(write.replies.slice(-3)).toEqual([0x5c, 0x5d, 0x47]);
    expect(m.sio.cards[0].dirty).toBe(true);

    const read = exchange(m, 0, [0x81, 0x52, 0, 0, 0x00, 0x45, 0, 0, 0, 0, ...Array(128).fill(0), 0, 0]);
    expect(read.replies[1]).toBe(0x00);
    expect(read.replies.slice(2, 4)).toEqual([0x5a, 0x5d]);
    expect(read.replies.slice(10, 138)).toEqual(data);
    expect(read.replies[138]).toBe(checksum);
    expect(read.replies[139]).toBe(0x47);
  });

  it('gives the card ID for command S', () => {
    const m = machine();
    const { replies } = exchange(m, 1, [0x81, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(replies.slice(2)).toEqual([0x5a, 0x5d, 0x5c, 0x5d, 0x04, 0x00, 0x00, 0x80]);
  });

  it('starts cards formatted and reads DexDrive files', () => {
    const card = formattedCard();
    expect(String.fromCharCode(card[0], card[1])).toBe('MC');
    const gme = new Uint8Array(MEMORY_CARD_SIZE + 3904);
    gme.set(new TextEncoder().encode('123-456-STD'));
    gme.set(card, 3904);
    expect(readMemoryCardFile(gme)).toEqual(card);
    expect(() => readMemoryCardFile(new Uint8Array(100))).toThrow();
  });
});
