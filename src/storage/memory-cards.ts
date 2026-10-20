import { MEMORY_CARD_SIZE } from '../sio/memory-card';
import type { KeyValueStore } from './store';

/**
 * The two memory cards, kept in browser storage. Like real cards they belong
 * to the console, not to a game: every game saves to the same two.
 */
export class MemoryCards {
  constructor(private readonly store: KeyValueStore<Uint8Array>) {}

  async load(slot: number): Promise<Uint8Array | null> {
    const data = await this.store.get(`card-${slot}`);
    return data && data.length === MEMORY_CARD_SIZE ? data : null;
  }

  save(slot: number, data: Uint8Array): Promise<void> {
    return this.store.put(`card-${slot}`, data.slice());
  }
}

/**
 * A memory card file: a raw 128K image (.mcr, .mcd, .mem, .srm), or the
 * DexDrive format (.gme), which has a 3904-byte header before the image.
 */
export function readMemoryCardFile(bytes: Uint8Array): Uint8Array {
  if (bytes.length === MEMORY_CARD_SIZE) return bytes;
  if (bytes.length === MEMORY_CARD_SIZE + 3904 && new TextDecoder().decode(bytes.subarray(0, 11)) === '123-456-STD') return bytes.slice(3904);
  throw new Error('That file is not a memory card image (a raw .mcr image is 128K).');
}
