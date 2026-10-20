import { BIOS_SIZE } from '../bus';
import { crc32 } from '../util/crc32';
import type { KeyValueStore } from './store';

const KEY = 'bios';

/** BIOS dumps people are likely to have, by CRC-32, to name them in the page. */
const KNOWN_BIOSES: Record<number, string> = {
  0x3b601fc8: 'SCPH-1000 (Japan)',
  0x3539def6: 'SCPH-3000 (Japan)',
  0xbc190209: 'SCPH-3500 (Japan)',
  0x24fc7e17: 'SCPH-5000 (Japan)',
  0xff3eeb8c: 'SCPH-5500 (Japan)',
  0xec541cd0: 'SCPH-7000 (Japan)',
  0x37157331: 'SCPH-1001 (USA)',
  0x8d8cb7e4: 'SCPH-7003 (USA)',
  0x502224b6: 'SCPH-7001 (USA)',
  0x171bdcec: 'SCPH-101 (PS one, USA)',
  0x9bb87c4b: 'SCPH-1002 (Europe)',
  0xd786f0b9: 'SCPH-5502/5552 (Europe)',
  0x318178bf: 'SCPH-7502 (Europe)',
};

/** Dumps known to be damaged: they crash while unpacking their shell, before the Sony logo. */
const BAD_DUMPS: Record<number, string> = {
  0x4d9e7c86: 'SCPH-5502',
};

/** File names that say they are a BIOS, so a dropped one isn't taken for a game. */
export function looksLikeBios(fileName: string): boolean {
  return /\b(bios|scph\d+|ps-?\d{2}[ajeu])\b|(bios|scph)[\s._-]/i.test(fileName) || /^scph/i.test(fileName);
}

/** Checks a BIOS image: 512K. */
export function checkBios(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== BIOS_SIZE) throw new Error(`That file (${bytes.length} bytes) isn't a PlayStation BIOS, which is 512K.`);
  const bad = BAD_DUMPS[crc32(bytes)];
  if (bad) throw new Error(`That is a damaged dump of the ${bad} BIOS (it crashes before the Sony logo). Use another dump.`);
  return bytes;
}

/** A name for a BIOS image: the console model for known dumps. */
export function biosName(bytes: Uint8Array): string {
  return KNOWN_BIOSES[crc32(bytes)] ?? 'Your BIOS';
}

/** The player's own BIOS, kept in browser storage so it only has to be given once. */
export class BiosStore {
  constructor(private readonly store: KeyValueStore<Uint8Array>) {}

  async load(): Promise<Uint8Array | null> {
    return (await this.store.get(KEY)) ?? null;
  }

  save(bytes: Uint8Array): Promise<void> {
    return this.store.put(KEY, bytes.slice());
  }

  forget(): Promise<void> {
    return this.store.delete(KEY);
  }
}
