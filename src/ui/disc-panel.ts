export interface GameListing {
  title: string;
  credit?: string;
  license?: string;
  licenseHref?: string;
  sourceHref?: string;
  hint?: string;
}

export interface DiscPanelCallbacks {
  /** Files were dropped or chosen together (a .cue with its .bin files, an image, a program, a state, a card). */
  onFiles(files: File[]): Promise<void>;
  /** Downloads one of the free games and puts it in. */
  onGame(index: number): Promise<void>;
  onEject(): void;
  onBiosFile(file: File): Promise<void>;
  onUseBios(useOwn: boolean): void;
  onForgetBios(): Promise<void>;
  onExportCard(slot: number): void;
  onImportCard(slot: number, file: File): Promise<void>;
  focusScreen(): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Disc panel is missing ${selector}`);
  return element;
}

/** The disc tray: drop or choose files, pick free games, and manage the BIOS and memory cards. */
export class DiscPanel {
  private readonly fileInput: HTMLInputElement;
  private readonly message: HTMLElement;
  private readonly gamePicker: HTMLSelectElement;
  private readonly gameInfo: HTMLElement;
  private readonly useBios: HTMLInputElement;
  private games: GameListing[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: DiscPanelCallbacks,
  ) {
    this.fileInput = requireChild(root, 'input[name="disc-files"]');
    this.message = requireChild(root, '.cart-message');
    this.gamePicker = requireChild(root, 'select[name="bundled-game"]');
    this.gameInfo = requireChild(root, '.game-info');
    this.useBios = requireChild(root, 'input[name="use-own-bios"]');

    this.gamePicker.addEventListener('change', () => this.showGameInfo());
    requireChild<HTMLButtonElement>(root, '[data-action="play-game"]').addEventListener('click', () => {
      const index = Number(this.gamePicker.value);
      this.run(() => this.callbacks.onGame(index));
    });
    root.querySelectorAll<HTMLButtonElement>('[data-action="choose"]').forEach((button) => button.addEventListener('click', () => this.fileInput.click()));
    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      if (files.length) this.run(() => this.callbacks.onFiles(files));
    });
    requireChild<HTMLButtonElement>(root, '[data-action="eject"]').addEventListener('click', () => {
      this.callbacks.onEject();
      this.callbacks.focusScreen();
    });

    const biosInput = requireChild<HTMLInputElement>(root, 'input[name="bios-file"]');
    requireChild<HTMLButtonElement>(root, '[data-action="choose-bios"]').addEventListener('click', () => biosInput.click());
    biosInput.addEventListener('change', () => {
      const file = biosInput.files?.[0];
      biosInput.value = '';
      if (file) this.run(() => this.callbacks.onBiosFile(file));
    });
    this.useBios.addEventListener('change', () => {
      this.callbacks.onUseBios(this.useBios.checked);
      this.callbacks.focusScreen();
    });
    requireChild<HTMLButtonElement>(root, '[data-action="forget-bios"]').addEventListener('click', () => {
      if (confirm('Forget your BIOS? The console will use OpenBIOS again.')) this.run(() => this.callbacks.onForgetBios());
    });

    root.querySelectorAll<HTMLElement>('[data-card]').forEach((row) => {
      const slot = Number(row.dataset.card);
      const input = requireChild<HTMLInputElement>(row, 'input[type="file"]');
      requireChild<HTMLButtonElement>(row, '[data-action="export-card"]').addEventListener('click', () => {
        this.callbacks.onExportCard(slot);
        this.callbacks.focusScreen();
      });
      requireChild<HTMLButtonElement>(row, '[data-action="import-card"]').addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = '';
        if (file && confirm(`Replace memory card ${slot + 1} with ${file.name}? What is on the card now will be lost.`)) {
          this.run(() => this.callbacks.onImportCard(slot, file));
        }
      });
    });
    this.attachDragAndDrop();
  }

  /** Files can be dropped anywhere on the page; a .cue and its .bin files are dropped together. */
  private attachDragAndDrop(): void {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    document.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      depth++;
      this.root.classList.add('drag-over');
    });
    document.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.root.classList.remove('drag-over');
    });
    document.addEventListener('dragover', (event) => {
      if (hasFiles(event)) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      this.root.classList.remove('drag-over');
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length) this.run(() => this.callbacks.onFiles(files));
    });
  }

  private run(action: () => Promise<void>): void {
    this.showMessage('');
    action()
      .catch((error: unknown) => this.showMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => this.callbacks.focusScreen());
  }

  showMessage(text: string, isWarning = false): void {
    this.message.textContent = text;
    this.message.classList.toggle('warning', isWarning);
  }

  /** Shows what is in the console: its title and a line about it. */
  showMedia(title: string, details: string): void {
    this.root.dataset.state = 'loaded';
    requireChild(this.root, '.cart-name').textContent = title;
    requireChild(this.root, '.cart-details').textContent = details;
  }

  showEmpty(): void {
    this.root.dataset.state = 'empty';
  }

  /** Shows whether the player's own BIOS is kept, and its name. */
  showBios(name: string | null, inUse: boolean): void {
    requireChild(this.root, '.boot-rom-status').textContent = name ? `${name} kept in this browser` : 'Using OpenBIOS, the free BIOS';
    requireChild<HTMLButtonElement>(this.root, '[data-action="forget-bios"]').hidden = !name;
    this.useBios.disabled = !name;
    this.useBios.checked = inUse && name !== null;
  }

  setGames(games: GameListing[]): void {
    this.games = games;
    requireChild<HTMLElement>(this.root, '.bundled-games').hidden = games.length === 0;
    this.gamePicker.replaceChildren(
      ...games.map((game, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = game.title;
        return option;
      }),
    );
    this.showGameInfo();
  }

  /** The chosen game's credit, licence, source and hint, with links. */
  private showGameInfo(): void {
    const game = this.games[Number(this.gamePicker.value)];
    this.gameInfo.replaceChildren();
    if (!game) return;
    const link = (href: string, text: string) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.textContent = text;
      return anchor;
    };
    const parts: (string | Node)[] = [];
    if (game.credit) parts.push(game.credit);
    if (game.license) parts.push(game.licenseHref ? link(game.licenseHref, game.license) : game.license);
    if (game.sourceHref) parts.push(link(game.sourceHref, 'source'));
    if (game.hint) parts.push(game.hint);
    parts.forEach((part, i) => {
      if (i > 0) this.gameInfo.append(' · ');
      this.gameInfo.append(part);
    });
  }
}
