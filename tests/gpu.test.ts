import { describe, expect, it } from 'vitest';
import { PlayStation } from '../src/playstation';

describe('GPU display', () => {
  it('scans out 24-bit pictures (as full-motion video uses) three bytes per pixel', () => {
    const m = new PlayStation();
    m.powerOn();
    const gpu = m.gpu;
    gpu.gp1(0x03000000); // display on
    gpu.gp1(0x08000011); // 320 wide, 24-bit
    gpu.gp1(0x05000000); // display from (0, 0)
    // Bytes 11 22 33 | 44 55 66 → pixel 0 = RGB(11, 22, 33), pixel 1 = RGB(44, 55, 66).
    gpu.vram[0] = 0x2211;
    gpu.vram[1] = 0x4433;
    gpu.vram[2] = 0x6655;
    m.runFrame();
    expect(gpu.frameWidth).toBe(320);
    expect(gpu.framebuffer[0] & 0xffffff).toBe(0x332211);
    expect(gpu.framebuffer[1] & 0xffffff).toBe(0x665544);
  });

  it('shows black while the display is off', () => {
    const m = new PlayStation();
    m.powerOn();
    m.gpu.vram.fill(0x7fff);
    m.runFrame();
    expect(m.gpu.framebuffer[0]).toBe(0xff000000);
  });

  it('switches to PAL timing (50 frames a second) with GP1(08h) bit 3', () => {
    const m = new PlayStation();
    m.powerOn();
    m.gpu.gp1(0x08000009);
    const start = m.gpu.frameCount;
    m.run(m.clockHz);
    expect(m.gpu.frameCount - start).toBeGreaterThanOrEqual(49);
    expect(m.gpu.frameCount - start).toBeLessThanOrEqual(51);
  });
});
