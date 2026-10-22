import { AudioOutput } from './audio/audio-output';
import { fetchGame, loadGameManifest, type BundledGame } from './games';
import { ControllerInput } from './io/controllers';
import { GamepadManager, padName, readGamepad, RumbleOutput } from './io/gamepad-input';
import { PointerInput } from './io/pointer-input';
import { KeyboardInput } from './io/keyboard-input';
import { fileKind, gameName, STATE_EXTENSION, titleFromFileName } from './media';
import type { ConsoleStatus, FromWorker, Rumble, ToWorker } from './protocol';
import { SCREEN_ASPECT } from './render/screen';
import { formattedCard } from './sio/memory-card';
import type { PadState, PadType } from './sio/pad';
import { BiosStore, biosName, checkBios, looksLikeBios } from './storage/bios-store';
import { MemoryCards, readMemoryCardFile } from './storage/memory-cards';
import { SaveStates, type SaveStateRecord } from './storage/save-states';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { BiosSetup } from './ui/bios-setup';
import { DiscPanel } from './ui/disc-panel';
import { downloadFile } from './ui/download';
import { Settings } from './ui/settings';
import { attachToolbar } from './ui/toolbar';
import { OnScreenPad } from './ui/touch-pad';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = ['pad1', 'pad2', 'multitap', 'show-pad', 'pad-player', 'sound', 'volume', 'fast-boot', 'fast-seeks'];
const USE_OWN_BIOS_KEY = 'playstation-use-own-bios';
/** Two ports, or five players with a Multitap (four on it, one on the other port). */
const MAX_PLAYERS = 5;
const STILL: Rumble = { strong: 0, weak: 0 };

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'playstation';

const controlsHint = (type: PadType) => {
  if (type === 'guncon') return 'Aim with the mouse: left button fires, right is A, middle is B, Shift-click reloads';
  if (type === 'mouse') return 'Click the screen to use the mouse; Esc lets it go';
  return 'Arrows, S Z X C and Enter play';
};
const padLabel = (type: PadType, analog: boolean) => {
  if (type === 'dualshock') return `DualShock${analog ? ' (analog)' : ''}`;
  if (type === 'guncon') return 'GunCon';
  if (type === 'mouse') return 'mouse';
  return 'digital pad';
};

async function loadOpenBios(): Promise<Uint8Array> {
  const response = await fetch(`${import.meta.env.BASE_URL}bios/openbios.bin`);
  const isPage = response.headers.get('content-type')?.includes('text/html') ?? false;
  if (!response.ok || isPage) throw new Error('OpenBIOS is missing from this site (run npm run fetch:bios).');
  return new Uint8Array(await response.arrayBuffer());
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');
  document.documentElement.style.setProperty('--screen-aspect', SCREEN_ASPECT.toFixed(4));

  try {
    if (!('transferControlToOffscreen' in canvas)) throw new Error('This browser is too old for the emulator (no OffscreenCanvas).');
    const settings = new Settings();
    const showPad = requireElement<HTMLInputElement>('input[name="show-pad"]');
    showPad.checked = matchMedia('(pointer: coarse)').matches;
    settings.bind(document, REMEMBERED_SETTINGS);

    const stores = await openBrowserStores().catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      requireElement<HTMLElement>('.bios-storage-note').textContent =
        "This browser isn't letting the page store files, so your BIOS will be forgotten when you close it.";
      return memoryStores();
    });
    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);
    const memoryCards = new MemoryCards(stores.memoryCards as KeyValueStore<Uint8Array>);
    const biosStore = new BiosStore(stores.bios as KeyValueStore<Uint8Array>);
    const cards = await Promise.all([0, 1].map((slot) => memoryCards.load(slot).catch(() => null)));
    const cardData = cards.map((data) => data ?? formattedCard());
    let userBios = await biosStore.load().catch(() => null);
    let useOwnBios = userBios !== null && localStorage.getItem(USE_OWN_BIOS_KEY) !== 'false';
    const openBios = await loadOpenBios();

    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });

    // --- The worker ---------------------------------------------------------------------
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const post = (message: ToWorker, transfer: Transferable[] = []) => worker.postMessage(message, transfer);
    const offscreen = canvas.transferControlToOffscreen();
    post(
      {
        type: 'init',
        canvas: offscreen,
        audioPort: audio?.port ?? null,
        sampleRate: audio?.sampleRate ?? 44100,
        openBios,
        userBios,
        useUserBios: useOwnBios,
        cards: cardData.map((data) => data.slice()),
      },
      audio ? [offscreen, audio.port] : [offscreen],
    );

    let consoleStatus: ConsoleStatus | null = null;
    let speed = 1;
    let paused = false;
    let fastForward = false;
    let waitingForFrame = false;
    let rumble: Rumble[] = [];
    // Set up with the other inputs, once the toolbar knows the pad types.
    let pointer: PointerInput;
    let pendingState: { resolve: (value: { bytes: Uint8Array; title: string }) => void; reject: (error: Error) => void } | null = null;
    let pendingLoad: { resolve: () => void; reject: (error: Error) => void } | null = null;
    // Keyboard focus goes back to the game without scrolling the page to it.
    const focusScreen = () => canvas.focus({ preventScroll: true });

    const updateStatus = () => {
      const s = consoleStatus;
      if (!s) return;
      const parts = [s.title ?? 'No disc', s.bios === 'OpenBIOS' ? 'OpenBIOS' : 'your BIOS'];
      s.pads.forEach((pad, i) => parts.push(`pad ${i + 1}: ${padLabel(pad.type, pad.analog)}${i === s.multitap ? ' on a Multitap' : ''}`));
      if (speed < 0.95) parts.push(`running at ${Math.round(speed * 100)}% speed`);
      status.textContent = `${parts.join(' · ')} · ${controlsHint(s.pads[0]?.type ?? 'digital')}`;
      screenFrame.classList.toggle('empty', s.title === null);
      toolbar.setCanSave(s.title !== null);
      toolbar.setAnalog(s.pads[0]?.type === 'dualshock', s.pads[0]?.analog ?? false);
    };

    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      switch (message.type) {
        case 'frame':
          waitingForFrame = false;
          rumble = message.rumble;
          if (Math.abs(message.speed - speed) > 0.02) {
            speed = message.speed;
            updateStatus();
          }
          return;
        case 'status':
          consoleStatus = message.status;
          updateStatus();
          return;
        case 'media-loaded':
          discPanel.showMedia(message.title, message.details);
          if (message.swapped) discPanel.showMessage(`Discs swapped: ${message.title} is in, without restarting.`, true);
          else audio?.flush();
          return;
        case 'memory-card':
          cardData[message.slot] = message.data;
          void memoryCards.save(message.slot, message.data).catch((error: unknown) => console.warn('Could not keep the memory card:', error));
          return;
        case 'state':
          pendingState?.resolve(message);
          pendingState = null;
          return;
        case 'state-loaded':
          pendingLoad?.resolve();
          pendingLoad = null;
          audio?.flush();
          return;
        case 'tty':
          for (const line of message.text.split('\n')) if (line.trim()) console.info(`[PlayStation] ${line}`);
          return;
        case 'error':
          if (message.context === 'state') {
            const error = new Error(message.message);
            pendingState?.reject(error);
            pendingLoad?.reject(error);
            pendingState = pendingLoad = null;
          } else if (message.context === 'media') {
            discPanel.showMessage(message.message);
          } else {
            toolbar.showMessage(message.message, true);
          }
          return;
      }
    };
    worker.onerror = (event) => {
      status.textContent = `The emulator failed to start: ${event.message}`;
    };

    const requestState = () =>
      new Promise<{ bytes: Uint8Array; title: string }>((resolve, reject) => {
        pendingState = { resolve, reject };
        post({ type: 'save-state' });
      });
    const loadState = (bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        pendingLoad = { resolve, reject };
        post({ type: 'load-state', bytes }, [bytes.buffer]);
      });

    // --- BIOS ---------------------------------------------------------------------------
    const applyBios = () => {
      post({ type: 'bios', userBios, useUserBios: useOwnBios });
      biosSetup.showBios(userBios ? biosName(userBios) : null, useOwnBios);
      try {
        localStorage.setItem(USE_OWN_BIOS_KEY, String(useOwnBios));
      } catch {
        // Not remembered.
      }
      audio?.flush();
    };
    const useBiosImage = async (bytes: Uint8Array) => {
      const image = checkBios(bytes);
      await biosStore.save(image);
      userBios = image;
      useOwnBios = true;
      applyBios();
      return `${biosName(image)} kept in this browser; the console was switched off and on to use it.`;
    };

    // --- Files --------------------------------------------------------------------------
    const importCard = async (slot: number, file: File) => {
      const data = readMemoryCardFile(new Uint8Array(await file.arrayBuffer()));
      cardData[slot] = data;
      await memoryCards.save(slot, data);
      post({ type: 'memory-card', slot, data: data.slice() });
      discPanel.showMessage(`Memory card ${slot + 1} replaced with ${file.name}.`, true);
    };

    const onFiles = async (files: File[], swap = false) => {
      const state = files.find((file) => fileKind(file.name) === 'state');
      if (state) {
        await loadState(new Uint8Array(await state.arrayBuffer()));
        toolbar.showMessage('Save state loaded');
        return;
      }
      const card = files.find((file) => fileKind(file.name) === 'memory-card');
      if (card) {
        if (confirm(`Put ${card.name} in as memory card 1? What is on the card now will be lost.`)) await importCard(0, card);
        return;
      }
      const bios = files.find((file) => file.size === 0x80000 && (looksLikeBios(file.name) || fileKind(file.name) === 'other'));
      if (bios && files.length === 1) {
        discPanel.showMessage(await useBiosImage(new Uint8Array(await bios.arrayBuffer())), true);
        return;
      }
      // Another disc of the game that's running goes in without a restart, as on the console.
      const disc = files.find((file) => fileKind(file.name) === 'disc');
      const current = consoleStatus?.kind === 'disc' ? consoleStatus.title : null;
      const sameGame = disc && current !== null && gameName(titleFromFileName(disc.name)) === gameName(current) && titleFromFileName(disc.name) !== current;
      post({ type: 'media', files, swap: swap || !!sameGame });
    };

    // --- Panels -------------------------------------------------------------------------
    let bundledGames: BundledGame[] = [];
    const discPanel = new DiscPanel(requireElement('#disc-panel'), {
      onFiles,
      onGame: async (index) => {
        const game = bundledGames[index];
        post({ type: 'media', files: [await fetchGame(import.meta.env.BASE_URL, game)], title: game.title });
      },
      onEject: () => {
        post({ type: 'eject' });
        discPanel.showEmpty();
      },
      onExportCard: (slot) => downloadFile(cardData[slot], `memory-card-${slot + 1}.mcr`),
      onImportCard: importCard,
      focusScreen,
    });
    const biosSetup = new BiosSetup(requireElement('#bios-setup'), {
      onBiosFile: async (file) => useBiosImage(new Uint8Array(await file.arrayBuffer())),
      onUseBios: (useOwn) => {
        useOwnBios = useOwn && userBios !== null;
        applyBios();
      },
      onForgetBios: async () => {
        await biosStore.forget();
        userBios = null;
        useOwnBios = false;
        applyBios();
      },
      onClose: () => {
        post({ type: 'pause', paused });
        audio?.flush();
        focusScreen();
      },
    });
    biosSetup.showBios(userBios ? biosName(userBios) : null, useOwnBios);

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const toolbar = attachToolbar(requireElement('#toolbar'), {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        post({ type: 'pause', paused: pause || biosSetup.isOpen });
        audio?.flush();
      },
      onReset: () => post({ type: 'reset' }),
      onPowerCycle: () => {
        post({ type: 'power' });
        audio?.flush();
      },
      onFullscreen: () => {
        if (document.fullscreenElement) {
          void document.exitFullscreen();
          return;
        }
        void screenFrame.requestFullscreen().then(focusScreen);
      },
      onPadTypes: (types) => {
        post({ type: 'pad-types', types });
        pointer.setPadTypes(types);
      },
      onAnalog: () => post({ type: 'analog', port: 0 }),
      onSaveState: async () => {
        const { bytes, title } = await requestState();
        await saveStates.add(title, bytes);
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const bytes = await saveStates.load(id);
        if (!bytes) throw new Error('That save state no longer exists.');
        await loadState(bytes.slice());
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        const { bytes, title } = await requestState();
        downloadFile(bytes, `${slug(title)}${STATE_EXTENSION}`);
      },
      onImportState: async (file) => {
        await loadState(new Uint8Array(await file.arrayBuffer()));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen,
    });
    await refreshStates();
    post({ type: 'pad-types', types: toolbar.padTypes });

    requireElement<HTMLButtonElement>('#toolbar [data-action="change-bios"]').addEventListener('click', () => {
      post({ type: 'pause', paused: true });
      audio?.flush();
      biosSetup.open();
    });

    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games;
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      discPanel.setGames(games.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })));
    });

    // --- Inputs -------------------------------------------------------------------------
    const controllers = Array.from({ length: MAX_PLAYERS }, () => new ControllerInput());
    const multitap = requireElement<HTMLSelectElement>('select[name="multitap"]');
    const tapPort = () => (multitap.value === '' ? null : Number(multitap.value));
    const players = () => (tapPort() === null ? 2 : MAX_PLAYERS);
    // Players go port by port, a Multitap's four in its port's place: port 2's first player is player 2 or 5.
    pointer = new PointerInput(canvas, (port) => controllers[port === 0 ? 0 : tapPort() === 0 ? MAX_PLAYERS - 1 : 1]);
    pointer.setPadTypes(toolbar.padTypes);
    const applyMultitap = () => {
      post({ type: 'multitap', port: tapPort() });
      pointer.setPadTypes(toolbar.padTypes);
    };
    multitap.addEventListener('change', () => {
      applyMultitap();
      focusScreen();
    });
    applyMultitap();
    new KeyboardInput(controllers[0], {
      onPause: () => toolbar.setPaused(!toolbar.paused),
      onFastForward: (held) => {
        fastForward = held;
        if (!held) audio?.flush();
      },
    }).attach(window);
    const gamepads = new GamepadManager();
    const rumbleOutput = new RumbleOutput();
    gamepads.attach(window);
    const gamepadStatus = requireElement<HTMLElement>('.gamepad-status');

    const padRoot = requireElement<HTMLElement>('#pad');
    const pad = new OnScreenPad(padRoot, controllers[0], focusScreen);
    const padPlayer = requireElement<HTMLSelectElement>('select[name="pad-player"]');
    const applyPad = () => {
      padRoot.hidden = !showPad.checked;
      pad.setController(controllers[padPlayer.value === '1' ? 1 : 0]);
    };
    showPad.addEventListener('change', applyPad);
    padPlayer.addEventListener('change', applyPad);
    applyPad();

    const sound = requireElement<HTMLInputElement>('input[name="sound"]');
    const volume = requireElement<HTMLInputElement>('input[name="volume"]');
    const soundHint = requireElement<HTMLElement>('.sound-hint');
    const applySound = () => {
      post({ type: 'sound', enabled: sound.checked });
      audio?.setVolume(Number(volume.value));
      if (!sound.checked) audio?.flush();
    };
    sound.addEventListener('change', applySound);
    volume.addEventListener('input', applySound);
    applySound();

    const fastBoot = requireElement<HTMLInputElement>('input[name="fast-boot"]');
    const applyFastBoot = () => post({ type: 'fast-boot', enabled: fastBoot.checked });
    fastBoot.addEventListener('change', applyFastBoot);
    applyFastBoot();

    const fastSeeks = requireElement<HTMLInputElement>('input[name="fast-seeks"]');
    const applyFastSeeks = () => post({ type: 'fast-seeks', enabled: fastSeeks.checked });
    fastSeeks.addEventListener('change', applyFastSeeks);
    applyFastSeeks();
    if (!audio) {
      sound.disabled = volume.disabled = true;
      soundHint.textContent = 'Sound is not supported in this browser';
      soundHint.hidden = false;
    } else if (!audio.running) {
      soundHint.hidden = false;
      audio.resumeOnGesture(window, () => (soundHint.hidden = true));
    }

    // --- Main loop ----------------------------------------------------------------------
    let lastPadNames = '';
    let lastPads = '';
    const pollInputs = (now: number) => {
      const pads = gamepads.connected();
      for (let player = 0; player < players(); player++) {
        const gamepad = pads[player];
        if (gamepad) {
          controllers[player].set('gamepad', readGamepad(gamepad));
          rumbleOutput.update(gamepad, rumble[player] ?? STILL, now);
        } else controllers[player].clear('gamepad');
      }
      const motion = pointer.takeMotion();
      if (motion) post({ type: 'mouse-motion', ...motion });
      const states: PadState[] = controllers.slice(0, players()).map((controller) => controller.state);
      const key = JSON.stringify(states);
      if (key !== lastPads) {
        lastPads = key;
        post({ type: 'pads', pads: states });
      }
      const names = pads
        .slice(0, players())
        .map((gamepad, player) => `Player ${player + 1}: ${padName(gamepad)}`)
        .join(' · ');
      if (names !== lastPadNames) {
        lastPadNames = names;
        gamepadStatus.textContent = names;
      }
    };

    let last = performance.now();
    const frame = (now: number) => {
      pollInputs(now);
      // The worker gets the next slice of time only once it has shown the last one, so a slow
      // computer runs the game slower rather than piling up work.
      if (!waitingForFrame) {
        const elapsed = now - last;
        last = now;
        waitingForFrame = true;
        post({ type: 'run', elapsed: paused ? 0 : elapsed, fastForward });
      }
      requestAnimationFrame(frame);
    };
    focusScreen();
    requestAnimationFrame(frame);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
