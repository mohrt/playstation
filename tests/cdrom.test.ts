import { describe, expect, it } from 'vitest';
import { XaDecoder } from '../src/cdrom/xa';
import { Disc, MemorySource, SECTOR_SIZE } from '../src/disc/disc';
import { Irq } from '../src/irq';
import { PlayStation } from '../src/playstation';

const CD = 0x1f801800;

/** A disc with a data track (each sector's data starts with its LBA) and an audio track. */
function testDisc(): Disc {
  const data = new Uint8Array(40 * SECTOR_SIZE);
  for (let lba = 0; lba < 40; lba++) {
    const sector = data.subarray(lba * SECTOR_SIZE);
    sector[18] = sector[22] = 0x08;
    sector[24] = lba;
    sector[25] = 0xa5;
  }
  const audio = new Uint8Array(20 * SECTOR_SIZE);
  for (let i = 0; i < audio.length; i += 4) {
    audio[i + 1] = 0x10; // left = 0x1000
    audio[i + 3] = 0xf0; // right = -0x1000
  }
  const cue = 'FILE "d.bin" BINARY\n TRACK 01 MODE2/2352\n  INDEX 01 00:00:00\nFILE "a.bin" BINARY\n TRACK 02 AUDIO\n  INDEX 01 00:00:00\n';
  return Disc.fromCue(
    cue,
    new Map([
      ['d.bin', new MemorySource(data)],
      ['a.bin', new MemorySource(audio)],
    ]),
  );
}

class Drive {
  readonly m = new PlayStation();

  constructor() {
    this.m.insertDisc(testDisc());
    this.m.powerOn();
    this.m.irq.writeMask(1 << Irq.CdRom);
    this.m.bus.write8(CD, 1);
    this.m.bus.write8(CD + 2, 0x1f); // all interrupts enabled
  }

  /** Sends a command and waits for its first interrupt; returns [type, response bytes]. */
  command(command: number, params: number[] = []): [number, number[]] {
    const bus = this.m.bus;
    bus.write8(CD, 0);
    for (const p of params) bus.write8(CD + 2, p);
    bus.write8(CD + 1, command);
    return this.next();
  }

  /** Waits for the next interrupt, reads its response and acknowledges it. */
  next(maxCycles = 5_000_000): [number, number[]] {
    const bus = this.m.bus;
    for (let ran = 0; ran < maxCycles; ran += 1000) {
      this.m.run(1000);
      bus.write8(CD, 1);
      const type = bus.read8(CD + 3) & 7;
      if (type) {
        const response: number[] = [];
        while (bus.read8(CD) & 0x20) response.push(bus.read8(CD + 1));
        bus.write8(CD, 1);
        bus.write8(CD + 3, 7);
        return [type, response];
      }
    }
    throw new Error('no interrupt');
  }
}

describe('CD-ROM controller', () => {
  it('answers GetStat, GetTN and GetTD', () => {
    const d = new Drive();
    expect(d.command(0x01)).toEqual([3, [0x02]]);
    expect(d.command(0x13)).toEqual([3, [0x02, 0x01, 0x02]]);
    // Track 2 starts after 40 sectors of track 1, plus the 2-second lead-in: 00:02.
    expect(d.command(0x14, [0x02])).toEqual([3, [0x02, 0x00, 0x02]]);
  });

  it('identifies a licensed disc with GetID', () => {
    const d = new Drive();
    expect(d.command(0x1a)[0]).toBe(3);
    expect(d.next()).toEqual([2, [0x02, 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, 0x41]]);
  });

  it('reads sectors from where Setloc says, into the data FIFO', () => {
    const d = new Drive();
    const bus = d.m.bus;
    d.command(0x0e, [0x80]); // double speed, 2048-byte sectors
    d.command(0x02, [0x00, 0x02, 0x05]); // 00:02:05 = LBA 5
    expect(d.command(0x06)[0]).toBe(3);
    for (const lba of [5, 6]) {
      const [type] = d.next();
      expect(type).toBe(1);
      bus.write8(CD, 0);
      bus.write8(CD + 3, 0x80); // want data
      expect(bus.read8(CD + 2)).toBe(lba);
      expect(bus.read8(CD + 2)).toBe(0xa5);
      bus.write8(CD + 3, 0x00);
    }
    expect(d.command(0x09)[0]).toBe(3);
  });

  it('plays CD audio into the SPU', () => {
    const d = new Drive();
    d.command(0x0c); // demute
    expect(d.command(0x03, [0x02])[0]).toBe(3);
    d.m.run(2_000_000);
    const sample = new Int16Array(2);
    d.m.cdrom.nextSample(sample);
    expect(Array.from(sample)).toEqual([0x1000, -0x1000]);
  });

  it('swaps discs with the lid opening and closing, without a restart', () => {
    const d = new Drive();
    expect(d.command(0x01)).toEqual([3, [0x02]]);
    d.m.cdrom.swapDisc(testDisc(), 'pal');
    expect(d.command(0x01)[1][0] & 0x10).toBe(0x10); // lid open
    expect(d.command(0x13)[0]).toBe(5); // no disc while it's open
    d.m.run(40_000_000);
    expect(d.command(0x01)).toEqual([3, [0x12]]); // closed again: "was opened" shows once
    expect(d.command(0x01)).toEqual([3, [0x02]]);
    expect(d.command(0x1a)[0]).toBe(3);
    expect(d.next()[1][7]).toBe(0x45); // SCEE: the new disc's region
  });

  it('reports an error for commands that need a disc when there is none', () => {
    const d = new Drive();
    d.m.insertDisc(null);
    expect(d.command(0x13)[0]).toBe(5);
  });
});

describe('XA-ADPCM', () => {
  it('decodes a stereo 37.8 kHz sector to about 2350 samples at 44.1 kHz', () => {
    const sector = new Uint8Array(SECTOR_SIZE);
    sector[18] = 0x64; // realtime audio, form 2
    sector[19] = 0x01; // stereo, 37.8 kHz, 4-bit
    for (let group = 0; group < 18; group++) {
      const base = 24 + group * 128;
      for (let unit = 0; unit < 8; unit++) sector[base + 4 + unit] = 0x00; // shift 0, filter 0
      for (let i = 16; i < 128; i++) sector[base + i] = 0x11; // every sample +1 << 12
    }
    const decoder = new XaDecoder();
    const out: [number, number][] = [];
    decoder.decode(sector, (left, right) => out.push([left, right]));
    expect(out.length).toBeGreaterThan(2340);
    expect(out.length).toBeLessThan(2360);
    expect(out[100]).toEqual([0x1000, 0x1000]);
  });
});
