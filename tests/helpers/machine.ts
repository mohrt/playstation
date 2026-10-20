import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePsExe } from '../../src/exe';
import { PlayStation } from '../../src/playstation';

export const ROOT = join(__dirname, '..', '..');
export const BIOS_PATH = join(ROOT, 'public', 'bios', 'openbios.bin');
export const TESTS_DIR = join(ROOT, 'tests', 'fixtures', 'ps1-tests');

export const haveBios = existsSync(BIOS_PATH);
export const haveTests = existsSync(join(TESTS_DIR, 'README.md'));

/** A console with OpenBIOS in, switched on. */
export function bootedMachine(): PlayStation {
  const machine = new PlayStation();
  machine.loadBios(new Uint8Array(readFileSync(BIOS_PATH)));
  machine.powerOn();
  return machine;
}

export interface ExeRun {
  machine: PlayStation;
  tty: string;
  frames: number;
}

/** Side-loads a PS-EXE through OpenBIOS and runs it until `done(tty)` or `maxFrames`. */
export function runExe(path: string, maxFrames: number, done: (tty: string) => boolean = () => false): ExeRun {
  const machine = new PlayStation();
  machine.loadBios(new Uint8Array(readFileSync(BIOS_PATH)));
  machine.setExe(parsePsExe(new Uint8Array(readFileSync(path))));
  let tty = '';
  machine.onTty = (char) => (tty += String.fromCharCode(char));
  machine.powerOn();
  let frames = 0;
  while (frames < maxFrames && !done(tty)) {
    machine.runFrame();
    frames++;
  }
  return { machine, tty, frames };
}
