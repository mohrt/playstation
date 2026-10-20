// The emulation worker: runs the console off the page's main thread, draws
// into the transferred OffscreenCanvas and sends sound straight to the audio worklet.
import { Emulator } from './emulator';
import { parsePsExe } from './exe';
import { loadMedia } from './media';
import type { FromWorker, ToWorker } from './protocol';
import { Screen } from './render/screen';

/** How often written memory cards are sent to the page to keep. */
const CARD_SAVE_INTERVAL_MS = 1000;

let emulator: Emulator | null = null;
let paused = false;

const send = (message: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function sendStatus(): void {
  if (emulator) send({ type: 'status', status: emulator.status() });
}

let lastTty = 0;
let currentPbp: { name: string; size: number; disc: number } | null = null;
function flushTty(): void {
  if (!emulator || emulator.tty.length === lastTty) return;
  const text = emulator.tty.slice(lastTty);
  lastTty = emulator.tty.length;
  send({ type: 'tty', text });
}

function syncCards(): void {
  for (const card of emulator?.takeDirtyCards() ?? []) send({ type: 'memory-card', ...card }, [card.data.buffer]);
}

async function handle(message: ToWorker): Promise<void> {
  if (message.type === 'init') {
    emulator = new Emulator(new Screen(message.canvas), message.audioPort, message.sampleRate);
    emulator.setBios(message.openBios, message.userBios, message.useUserBios);
    message.cards.forEach((data, slot) => {
      if (data) emulator!.machine.sio.cards[slot].load(data);
    });
    emulator.machine.powerOn();
    setInterval(syncCards, CARD_SAVE_INTERVAL_MS);
    send({ type: 'ready' });
    sendStatus();
    return;
  }
  const emu = emulator;
  if (!emu) return;
  switch (message.type) {
    case 'run':
      if (!paused) {
        try {
          emu.run(message.elapsed, message.fastForward);
        } catch (error) {
          paused = true;
          send({ type: 'error', message: `The emulator stopped: ${errorText(error)}`, context: 'run' });
          console.error(error);
        }
      }
      flushTty();
      send({ type: 'frame', speed: emu.canRun && !paused ? emu.speed : 1 });
      return;
    case 'pause':
      paused = message.paused;
      emu.resetTiming();
      return;
    case 'media':
      try {
        // The multi-disc PBP that's running, dropped again, goes on to its next disc.
        const pbp = message.files.find((file) => file.name.toLowerCase().endsWith('.pbp'));
        const samePbp = pbp !== undefined && currentPbp !== null && pbp.name === currentPbp.name && pbp.size === currentPbp.size && emu.hasDisc && emu.canRun;
        const media = loadMedia(message.files, samePbp ? currentPbp!.disc + 1 : 0);
        if (message.title) media.title = message.title;
        const pbpDisc = media.kind === 'disc' ? media.pbpDisc : undefined;
        const swapped = (message.swap === true || (samePbp && pbpDisc !== undefined && pbpDisc.count > 1)) && media.kind === 'disc' && emu.hasDisc && emu.canRun;
        currentPbp = pbp && pbpDisc ? { name: pbp.name, size: pbp.size, disc: pbpDisc.number } : null;
        if (swapped) emu.swap(media);
        else {
          emu.insert(media);
          lastTty = emu.tty.length;
        }
        send({ type: 'media-loaded', title: media.title, details: media.details, kind: media.kind, swapped });
      } catch (error) {
        send({ type: 'error', message: errorText(error), context: 'media' });
      }
      sendStatus();
      return;
    case 'eject':
      emu.insert(null);
      sendStatus();
      return;
    case 'power':
      emu.powerOn();
      return;
    case 'reset':
      // The PlayStation's reset button restarts the console, as a power cycle does.
      emu.powerOn();
      return;
    case 'pads':
      emu.setPads(message.pads);
      return;
    case 'pad-types':
      emu.setPadTypes(message.types);
      sendStatus();
      return;
    case 'analog':
      emu.toggleAnalog(message.port);
      sendStatus();
      return;
    case 'bios':
      emu.setBios(null, message.userBios, message.useUserBios);
      emu.powerOn();
      sendStatus();
      return;
    case 'memory-card':
      emu.machine.sio.cards[message.slot].load(message.data);
      return;
    case 'sound':
      emu.soundEnabled = message.enabled;
      return;
    case 'fast-boot':
      emu.machine.fastBoot = message.enabled;
      return;
    case 'save-state':
      try {
        const bytes = await emu.saveState();
        send({ type: 'state', bytes, title: emu.title ?? 'PlayStation' }, [bytes.buffer]);
      } catch (error) {
        send({ type: 'error', message: errorText(error), context: 'state' });
      }
      return;
    case 'load-state':
      try {
        await emu.loadState(message.bytes, (bytes, title) => ({ kind: 'exe', exe: parsePsExe(bytes), bytes, title, details: 'PS-EXE' }));
        send({ type: 'state-loaded' });
      } catch (error) {
        send({ type: 'error', message: errorText(error), context: 'state' });
      }
      sendStatus();
      return;
  }
}

// Messages are handled one at a time, in order, even the ones that wait (save states).
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<ToWorker>) => {
  queue = queue.then(() => handle(event.data)).catch((error: unknown) => console.error(error));
};
