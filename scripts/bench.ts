// Measures emulation speed: boots a disc image (or a PS-EXE) through OpenBIOS
// and reports how many emulated frames per second this machine manages.
//   npm run bench -- path/to/game.cue|.bin|.exe [frames]
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Disc, discInfo, MemorySource, type ByteSource } from '../src/disc/disc';
import { isPsExe, parsePsExe } from '../src/exe';
import { PlayStation } from '../src/playstation';

const [path, framesArg] = process.argv.slice(2);
if (!path) {
  console.error('Usage: npm run bench -- <game.cue|game.bin|program.exe> [frames]');
  process.exit(1);
}
const frames = Number(framesArg ?? 1800);
const machine = new PlayStation();
machine.loadBios(new Uint8Array(readFileSync(join(process.cwd(), 'public', 'bios', 'openbios.bin'))));
const bytes = new Uint8Array(readFileSync(path));
if (isPsExe(bytes)) {
  machine.setExe(parsePsExe(bytes));
} else {
  let disc: Disc;
  if (path.toLowerCase().endsWith('.cue')) {
    const files = new Map<string, ByteSource>();
    const cue = new TextDecoder().decode(bytes);
    for (const match of cue.matchAll(/FILE\s+"([^"]+)"/gi)) files.set(basename(match[1]), new MemorySource(new Uint8Array(readFileSync(join(dirname(path), basename(match[1]))))));
    disc = Disc.fromCue(cue, files);
  } else {
    disc = Disc.fromImage(new MemorySource(bytes));
  }
  machine.insertDisc(disc, discInfo(disc).region);
}
machine.powerOn();
const start = performance.now();
for (let i = 1; i <= frames; i++) {
  machine.runFrame();
  if (i % 600 === 0) {
    const seconds = (performance.now() - start) / 1000;
    console.log(`${i} frames: ${(i / seconds).toFixed(1)} emulated frames per second (${((i / seconds / 60) * 100).toFixed(0)}% of real time)`);
  }
}
