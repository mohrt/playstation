export const MEMORY_CARD_SIZE = 0x20000;
const SECTOR_SIZE = 128;
const SECTORS = MEMORY_CARD_SIZE / SECTOR_SIZE;

/** A blank, formatted card: the header frame, 15 free directory frames, and a checksum on each. */
export function formattedCard(): Uint8Array {
  const data = new Uint8Array(MEMORY_CARD_SIZE);
  const frame = (index: number) => data.subarray(index * SECTOR_SIZE, (index + 1) * SECTOR_SIZE);
  const checksum = (bytes: Uint8Array) => {
    let x = 0;
    for (let i = 0; i < 127; i++) x ^= bytes[i];
    bytes[127] = x;
  };
  const header = frame(0);
  header[0] = 0x4d; // "MC"
  header[1] = 0x43;
  checksum(header);
  for (let i = 1; i < 16; i++) {
    const entry = frame(i);
    entry[0] = 0xa0; // free
    entry[8] = entry[9] = 0xff;
    checksum(entry);
  }
  // The broken-sector list: no replacements.
  for (let i = 16; i < 36; i++) {
    const entry = frame(i);
    entry.fill(0xff, 0, 4);
    entry[8] = entry[9] = 0xff;
    checksum(entry);
  }
  return data;
}

/**
 * A memory card on the serial bus, addressed with 81h: R reads a 128-byte
 * sector, W writes one, and S gives the card's ID. The flag byte's bit 3 is
 * set until the first write after power-on, which is how games notice a new card.
 */
export class MemoryCard {
  data: Uint8Array = formattedCard();
  /** Set when written, so the page knows to save the card. */
  dirty = false;
  private flag = 0x08;
  private position = 0;
  private command = 0;
  private sector = 0;
  private checksum = 0;
  private last = 0;
  private status = 0x47;

  reset(): void {
    this.flag = 0x08;
    this.deselect();
  }

  deselect(): void {
    this.position = 0;
    this.command = 0;
  }

  load(data: Uint8Array): void {
    if (data.length !== MEMORY_CARD_SIZE) throw new Error('A memory card image is 128K.');
    this.data = data.slice();
    this.flag = 0x08;
  }

  transfer(value: number): { reply: number; ack: boolean } {
    const position = this.position++;
    if (position === 0) {
      if (value !== 0x81) {
        this.position = Infinity;
        return { reply: 0xff, ack: false };
      }
      return { reply: 0xff, ack: true };
    }
    if (position === 1) {
      this.command = value;
      return { reply: this.flag, ack: value === 0x52 || value === 0x57 || value === 0x53 };
    }
    switch (this.command) {
      case 0x52:
        return this.read(position, value);
      case 0x57:
        return this.write(position, value);
      case 0x53:
        return this.identify(position);
      default:
        return { reply: 0xff, ack: false };
    }
  }

  private read(position: number, value: number): { reply: number; ack: boolean } {
    switch (position) {
      case 2:
        return { reply: 0x5a, ack: true };
      case 3:
        return { reply: 0x5d, ack: true };
      case 4:
        this.sector = value << 8;
        return { reply: 0x00, ack: true };
      case 5:
        this.sector |= value;
        if (this.sector >= SECTORS) this.sector = 0xffff;
        return { reply: this.sector >> 8, ack: true };
      case 6:
        return { reply: 0x5c, ack: true };
      case 7:
        return { reply: 0x5d, ack: true };
      case 8:
        this.checksum = (this.sector >> 8) ^ (this.sector & 0xff);
        return { reply: this.sector >> 8, ack: this.sector !== 0xffff };
      case 9:
        return { reply: this.sector & 0xff, ack: true };
    }
    if (position < 10 + SECTOR_SIZE) {
      const byte = this.data[this.sector * SECTOR_SIZE + position - 10];
      this.checksum ^= byte;
      return { reply: byte, ack: true };
    }
    if (position === 10 + SECTOR_SIZE) return { reply: this.checksum, ack: true };
    if (position === 11 + SECTOR_SIZE) return { reply: 0x47, ack: false };
    return { reply: 0xff, ack: false };
  }

  private write(position: number, value: number): { reply: number; ack: boolean } {
    const previous = this.last;
    this.last = value;
    switch (position) {
      case 2:
        return { reply: 0x5a, ack: true };
      case 3:
        return { reply: 0x5d, ack: true };
      case 4:
        this.sector = value << 8;
        return { reply: 0x00, ack: true };
      case 5:
        this.sector |= value;
        this.checksum = (this.sector >> 8) ^ (this.sector & 0xff);
        return { reply: previous, ack: true };
    }
    if (position < 6 + SECTOR_SIZE) {
      if (this.sector < SECTORS) this.data[this.sector * SECTOR_SIZE + position - 6] = value;
      this.checksum ^= value;
      return { reply: previous, ack: true };
    }
    switch (position - SECTOR_SIZE) {
      case 6:
        this.status = this.sector >= SECTORS ? 0xff : value === this.checksum ? 0x47 : 0x4e;
        if (this.status === 0x47) {
          this.flag &= ~0x08;
          this.dirty = true;
        }
        return { reply: previous, ack: true };
      case 7:
        return { reply: 0x5c, ack: true };
      case 8:
        return { reply: 0x5d, ack: true };
      case 9:
        return { reply: this.status, ack: false };
      default:
        return { reply: 0xff, ack: false };
    }
  }

  private identify(position: number): { reply: number; ack: boolean } {
    const replies = [0x5a, 0x5d, 0x5c, 0x5d, 0x04, 0x00, 0x00, 0x80];
    const index = position - 2;
    if (index >= replies.length) return { reply: 0xff, ack: false };
    return { reply: replies[index], ack: index < replies.length - 1 };
  }
}
