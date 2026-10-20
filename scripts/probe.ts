// Runs a disc (or PS-EXE) headless and saves screenshots, for checking games without a browser.
//   npm run probe -- game.cue [--frames 3600] [--shot 600] [--press 2400:start,2700:cross] [--bios file] [--out /tmp/probe]
// Presses hold a button for 8 frames from the given frame. Buttons are named as in PadButton (start, cross, up, l1...).
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ChdFile } from '../src/disc/chd';
import { Disc, type ByteSource } from '../src/disc/disc';
import { isPsExe, parsePsExe } from '../src/exe';
import { discMedia } from '../src/media';
import { PlayStation } from '../src/playstation';
import { idlePad, PadButton } from '../src/sio/pad';
import { captureState, decodeState, encodeState, restoreState } from '../src/state/snapshot';
import { encodePng } from '../tests/helpers/png';

class FileSource implements ByteSource {
  readonly size: number;
  private readonly fd: number;

  constructor(path: string) {
    this.size = statSync(path).size;
    this.fd = openSync(path, 'r');
  }

  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, Math.min(length, this.size - offset)));
    readSync(this.fd, out, 0, out.length, offset);
    return out;
  }

  close(): void {
    closeSync(this.fd);
  }
}

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const path = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!path) {
  console.error('Usage: npm run probe -- <game.cue|game.bin|program.exe> [--frames N] [--shot N] [--press frame:button,...] [--bios file] [--out dir]');
  process.exit(1);
}
const frames = Number(option('frames', '3600'));
const shot = Number(option('shot', '600'));
const out = option('out', '/tmp/probe');
const presses = option('press', '')
  .split(',')
  .filter(Boolean)
  .map((entry) => {
    const [frame, button] = entry.split(':');
    const key = Object.keys(PadButton).find((name) => name.toLowerCase() === button.toLowerCase()) as keyof typeof PadButton | undefined;
    if (!key) throw new Error(`Unknown button ${button}`);
    return { frame: Number(frame), button: PadButton[key] };
  });
mkdirSync(out, { recursive: true });
const name = basename(path).replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '-');

const machine = new PlayStation();
machine.loadBios(new Uint8Array(readFileSync(option('bios', join(process.cwd(), 'public', 'bios', 'openbios.bin')))));
const head = new FileSource(path).read(0, 0x800);
if (isPsExe(head)) {
  machine.setExe(parsePsExe(new Uint8Array(readFileSync(path))));
} else {
  let disc: Disc;
  if (path.toLowerCase().endsWith('.chd')) {
    disc = Disc.fromChd(new ChdFile(new FileSource(path)));
  } else if (path.toLowerCase().endsWith('.cue')) {
    const cue = readFileSync(path, 'utf8');
    const files = new Map<string, ByteSource>();
    for (const match of cue.matchAll(/FILE\s+"([^"]+)"/gi)) files.set(basename(match[1]), new FileSource(join(dirname(path), basename(match[1]))));
    disc = Disc.fromCue(cue, files);
  } else {
    disc = Disc.fromImage(new FileSource(path));
  }
  const media = discMedia(disc, basename(path));
  if (media.kind === 'disc') {
    console.log(`${media.title}: ${media.details}`);
    machine.insertDisc(disc, media.info.region);
  }
}
let tty = '';
machine.onTty = (char) => (tty += String.fromCharCode(char));
machine.powerOn();
// --resume state.json.gz continues from a state saved with --save-at frame:file (frames then count from it).
const resume = option('resume', '');
if (resume) restoreState(machine, await decodeState(new Uint8Array(readFileSync(resume))));
const [saveAt, saveFile] = option('save-at', '').split(':');

const counts = new Map<string, number>();
const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
if (args.includes('--spu')) {
  const raise = machine.irq.raise.bind(machine.irq);
  machine.irq.raise = (line) => {
    count(`irq ${line}${line === 6 ? ` @frame ${Math.floor(machine.gpu.frameCount / 600) * 600}` : ''}`);
    raise(line);
  };
  const write16 = machine.spu.write16.bind(machine.spu);
  machine.spu.write16 = (offset, value) => {
    if ((offset === 0x188 || offset === 0x18a) && value) count(`key on ${offset.toString(16)}=${value.toString(16)} @frame ${Math.floor(machine.gpu.frameCount / 300) * 300}`);
    if (offset === 0x1aa) count(`spu control ${value.toString(16)}`);
    write16(offset, value);
  };
  const timerWrite = machine.timers.write.bind(machine.timers);
  machine.timers.write = (offset, value) => {
    count(`timer write ${offset.toString(16)}=${(value & 0xffff).toString(16)} @frame ${Math.floor(machine.gpu.frameCount / 600) * 600}`);
    timerWrite(offset, value);
  };
  const dmaWrite = machine.spu.dmaWrite.bind(machine.spu);
  machine.spu.dmaWrite = (word) => {
    count('spu dma word');
    dmaWrite(word);
  };
}
const sioFrom = Number(option('sio', '0'));
const sioLog: string[] = [];
if (sioFrom) {
  for (const [kind, device] of [['pad', machine.sio.pads[0]], ['card', machine.sio.cards[0]]] as const) {
    const transfer = device.transfer.bind(device);
    device.transfer = (value: number) => {
      const result = transfer(value);
      if (machine.gpu.frameCount >= sioFrom && sioLog.length < 400) sioLog.push(`f${machine.gpu.frameCount} ${kind} ${value.toString(16)}→${result.reply.toString(16)}${result.ack ? '' : '!'}`);
      return result;
    };
  }
  const write = machine.sio.write.bind(machine.sio);
  machine.sio.write = (offset: number, value: number) => {
    if (offset === 0xa && machine.gpu.frameCount >= sioFrom && sioLog.length < 400) sioLog.push(`f${machine.gpu.frameCount} ctrl ${value.toString(16)}`);
    write(offset, value);
  };
}
let energy = 0;
let samples = 0;
const start = performance.now();
for (let frame = 1; frame <= frames; frame++) {
  let buttons = 0;
  for (const press of presses) if (frame >= press.frame && frame < press.frame + 8) buttons |= press.button;
  machine.sio.pads[0].state = { ...idlePad(), buttons };
  machine.runFrame();
  if (saveAt && frame === Number(saveAt)) {
    writeFileSync(saveFile, await encodeState(captureState(machine)));
    console.log(`state saved at frame ${frame} → ${saveFile}`);
  }
  machine.spu.sync();
  const sound = machine.spu.takeSamples();
  for (let i = 0; i < sound.length; i++) energy += sound[i] * sound[i];
  samples += sound.length;
  if (frame % shot === 0) {
    const { frameWidth: w, frameHeight: h, framebuffer } = machine.gpu;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = framebuffer[i] & 0xff;
      rgb[i * 3 + 1] = (framebuffer[i] >> 8) & 0xff;
      rgb[i * 3 + 2] = (framebuffer[i] >> 16) & 0xff;
    }
    const file = join(out, `${name}-${frame}.png`);
    writeFileSync(file, encodePng(w, h, rgb));
    const seconds = (performance.now() - start) / 1000;
    const rms = Math.sqrt(energy / Math.max(1, samples));
    energy = samples = 0;
    console.log(`frame ${frame}: ${w}x${h} ${machine.gpu.standard}, ${(frame / seconds).toFixed(0)} fps, sound ${rms.toFixed(3)}, pc ${(machine.cpu.pc >>> 0).toString(16)} → ${file}`);
  }
}
if (args.includes('--spu')) {
  const spu = machine.spu;
  const voices = spu.voices.map((v, i) => `${i}:${v.phase}/${v.adsrLevel.toString(16)}/${v.pitch.toString(16)}@${v.currentAddress.toString(16)} vol ${v.volumeLeft.level},${v.volumeRight.level}`);
  console.log(`SPU control ${spu.control.toString(16)} main ${spu.mainLeft.level},${spu.mainRight.level} (regs ${spu.mainLeft.register.toString(16)},${spu.mainRight.register.toString(16)}) reverb on ${spu.reverbOn.toString(16)} out ${spu.reverbOutLeft},${spu.reverbOutRight} cd ${spu.cdVolumeLeft},${spu.cdVolumeRight}`);
  console.log(voices.slice(0, 4).join('\n'));
  console.log([...counts].map(([k, n]) => `${k}: ${n}`).join(', '));
  const timers = machine.timers as unknown as { event: { time: number }; lastSync: number; counters: { pending: number; irqDone: boolean; waiting: boolean }[] };
  const gpuPrivate = machine.gpu as unknown as { lineEvent: { time: number }; lineFraction: number };
  console.log(`gpu frameCount ${machine.gpu.frameCount} after ${frames} runFrame calls; line ${machine.gpu.line} event ${gpuPrivate.lineEvent.time} fraction ${gpuPrivate.lineFraction} mode ${machine.gpu.displayMode.toString(16)}`);
  console.log(`timer event at ${timers.event.time}, now ${machine.sched.now}, lastSync ${timers.lastSync}, t2 pending ${timers.counters[2].pending} irqDone ${timers.counters[2].irqDone} waiting ${timers.counters[2].waiting}`);
  console.log(`irq mask ${machine.irq.mask.toString(16)} stat ${machine.irq.stat.toString(16)}; timers ${machine.timers.counters.map((t) => `count ${t.count.toString(16)} mode ${t.mode.toString(16)} target ${t.target.toString(16)}`).join(' | ')}`);
}
if (sioLog.length) console.log(`SIO:\n${sioLog.join(' ')}`);
const lines = tty.trim().split('\n');
if (lines.length) console.log(`TTY (last lines):\n${lines.slice(-8).join('\n')}`);
