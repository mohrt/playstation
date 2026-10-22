export interface BiosSetupCallbacks {
  /** A BIOS file was chosen or dropped; resolves with what to tell the player. */
  onBiosFile(file: File): Promise<string>;
  onUseBios(useOwn: boolean): void;
  onForgetBios(): Promise<void>;
  /** Back to the console. */
  onClose(): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`BIOS setup is missing ${selector}`);
  return element;
}

/** The BIOS setup, shown in place of the screen: the player's own BIOS instead of OpenBIOS, and the BIOS options. */
export class BiosSetup {
  private readonly message: HTMLElement;
  private readonly useBios: HTMLInputElement;
  private listeners: AbortController | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: BiosSetupCallbacks,
  ) {
    this.message = requireChild(root, '.bios-setup-message');
    this.useBios = requireChild(root, 'input[name="use-own-bios"]');

    const fileInput = requireChild<HTMLInputElement>(root, 'input[name="bios-file"]');
    requireChild<HTMLButtonElement>(root, '[data-action="choose-bios"]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) this.run(() => this.callbacks.onBiosFile(file));
    });
    this.useBios.addEventListener('change', () => this.callbacks.onUseBios(this.useBios.checked));
    requireChild<HTMLButtonElement>(root, '[data-action="forget-bios"]').addEventListener('click', () => {
      if (confirm('Forget your BIOS? The console will use OpenBIOS again.')) this.run(() => this.callbacks.onForgetBios());
    });
    requireChild<HTMLButtonElement>(root, '[data-action="back"]').addEventListener('click', () => this.close());
  }

  get isOpen(): boolean {
    return this.listeners !== null;
  }

  open(): void {
    if (this.listeners) return;
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    this.showMessage('');
    this.attachDragAndDrop(signal);
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') this.close();
      },
      { signal },
    );
    document.body.classList.add('choosing-bios');
    this.root.hidden = false;
    this.root.scrollIntoView({ block: 'start' });
  }

  close(): void {
    if (!this.listeners) return;
    this.listeners.abort();
    this.listeners = null;
    this.root.hidden = true;
    this.root.classList.remove('drag-over');
    document.body.classList.remove('choosing-bios');
    this.callbacks.onClose();
  }

  /** While open, a file dropped anywhere on the page is the BIOS. */
  private attachDragAndDrop(signal: AbortSignal): void {
    // Captured and stopped so the disc panel's page-wide drop handling doesn't also see the BIOS.
    const dragOptions = { signal, capture: true };
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    let depth = 0;
    window.addEventListener(
      'dragenter',
      (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        depth++;
        this.root.classList.add('drag-over');
      },
      dragOptions,
    );
    window.addEventListener(
      'dragover',
      (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      },
      dragOptions,
    );
    window.addEventListener(
      'dragleave',
      (event) => {
        if (!hasFiles(event)) return;
        event.stopImmediatePropagation();
        depth = Math.max(0, depth - 1);
        if (depth === 0) this.root.classList.remove('drag-over');
      },
      dragOptions,
    );
    window.addEventListener(
      'drop',
      (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        depth = 0;
        this.root.classList.remove('drag-over');
        const file = event.dataTransfer?.files[0];
        if (file) this.run(() => this.callbacks.onBiosFile(file));
      },
      dragOptions,
    );
  }

  private run(action: () => Promise<string | void>): void {
    this.showMessage('');
    action()
      .then((text) => this.showMessage(text ?? '', true))
      .catch((error: unknown) => this.showMessage(error instanceof Error ? error.message : String(error)));
  }

  showMessage(text: string, isWarning = false): void {
    this.message.textContent = text;
    this.message.classList.toggle('warning', isWarning);
  }

  /** Shows whether the player's own BIOS is kept, its name, and whether the console uses it. */
  showBios(name: string | null, inUse: boolean): void {
    const using = inUse && name !== null;
    requireChild<HTMLElement>(this.root, '.bios-rom').dataset.state = !name ? 'missing' : using ? 'loaded' : 'warning';
    requireChild(this.root, '.bios-rom-status').textContent = !name
      ? 'Not loaded: the console uses OpenBIOS, the free BIOS'
      : `Loaded: ${name}${using ? ', in use' : ', not in use: the console uses OpenBIOS'}`;
    requireChild<HTMLButtonElement>(this.root, '[data-action="forget-bios"]').hidden = !name;
    this.useBios.disabled = !name;
    this.useBios.checked = using;
  }
}
