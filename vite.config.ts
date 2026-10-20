/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the site works from a GitHub Pages project URL (/<repo>/).
  base: './',
  // The emulator runs in a module worker that imports the machine's modules.
  worker: { format: 'es' },
  // Test programs boot through the BIOS first, which takes a few emulated seconds.
  test: { testTimeout: 60_000 },
});
