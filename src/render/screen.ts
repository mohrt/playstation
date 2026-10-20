/** The TV picture is 4:3, whatever resolution the GPU scans out. */
export const SCREEN_ASPECT = 4 / 3;

/**
 * Puts the GPU's finished pictures on an OffscreenCanvas (in the worker). The
 * canvas takes the picture's size (256 to 640 wide, 240 to 576 tall); the page
 * stretches it to 4:3.
 */
export class Screen {
  private readonly context: OffscreenCanvasRenderingContext2D;
  private image: ImageData | null = null;
  private pixels: Uint32Array | null = null;

  constructor(private readonly canvas: OffscreenCanvas) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D drawing is not available');
    this.context = context;
  }

  private resize(width: number, height: number): void {
    if (this.image && this.image.width === width && this.image.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.image = this.context.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  /** Shows a picture: `frame` holds RGBA pixels (as little-endian words), `width` × `height` of them. */
  present(frame: Uint32Array, width: number, height: number): void {
    this.resize(width, height);
    this.pixels!.set(frame.subarray(0, width * height));
    this.context.putImageData(this.image!, 0, 0);
  }

  /** A dark screen with faint scanlines, shown while the console is off. */
  showIdle(): void {
    this.resize(320, 240);
    const pixels = this.pixels!;
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i / 320) & 1 ? 0xff141414 : 0xff1c1c1c;
    this.context.putImageData(this.image!, 0, 0);
  }
}
