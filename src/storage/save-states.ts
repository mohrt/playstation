import type { StateNode } from '../state/snapshot';
import { decodeState, encodeState } from '../state/snapshot';
import type { KeyValueStore } from './store';

/** What was in the console, so a state can tell which disc it needs. */
export interface MediaInfo {
  title: string;
  /** For discs: the serial (or file name when there's none) the same disc must have. */
  discId?: string;
  /** For side-loaded programs: the program itself (it is small). */
  exe?: Uint8Array;
  exeName?: string;
}

/** Everything needed to resume a game: the machine and what was in it. */
export interface Session {
  machine: StateNode;
  media: MediaInfo;
}

export interface SaveStateRecord {
  name: string;
  created: number;
  /** The session, gzipped (the same format as exported .psxstate files). */
  bytes: Uint8Array;
}

export interface SaveStateInfo {
  id: string;
  name: string;
  created: number;
}

/** Older states are dropped beyond this many. */
const MAX_STATES = 30;

/** Save states kept in browser storage, newest first. */
export class SaveStates {
  constructor(private readonly store: KeyValueStore<SaveStateRecord>) {}

  async add(name: string, bytes: Uint8Array): Promise<void> {
    const created = Date.now();
    await this.store.put(`state-${created}`, { name, created, bytes });
    const all = await this.list();
    for (const old of all.slice(MAX_STATES)) await this.store.delete(old.id);
  }

  async list(): Promise<SaveStateInfo[]> {
    const entries = await this.store.entries();
    return entries.map(([id, record]) => ({ id, name: record.name, created: record.created })).sort((a, b) => b.created - a.created);
  }

  async load(id: string): Promise<Uint8Array | null> {
    return (await this.store.get(id))?.bytes ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }
}

const MAGIC = 'playstation-session';

export async function encodeSession(session: Session): Promise<Uint8Array> {
  return encodeState({ magic: MAGIC, ...session });
}

export async function decodeSession(bytes: Uint8Array): Promise<Session> {
  const decoded = await decodeState<Session & { magic?: string }>(bytes).catch(() => null);
  if (decoded?.magic !== MAGIC) throw new Error('That file is not a PlayStation save state.');
  return decoded;
}
