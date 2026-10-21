// Downloads OpenBIOS, the free PlayStation BIOS written by the PCSX-Redux team
// (MIT licensed), as built and published by the Libreboot project. It is the
// BIOS the emulator starts with; it is kept out of git and fetched by the
// deploy workflow, together with its licence.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.mirrorservice.org/sites/libreboot.org/release/stable/26.10rev9/roms/playstation';
const SHA256 = 'da0bf3d3e0bf75d4bea49c037f9d0639d75c3ff4a569659965e04b9809b707c5';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'bios');
const biosFile = join(outDir, 'openbios.bin');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

await mkdir(outDir, { recursive: true });
if (existsSync(biosFile) && sha256(await readFile(biosFile)) === SHA256) {
  console.log('public/bios/openbios.bin is already there');
} else {
  const bios = await download(`${BASE}/openbios.bin`);
  if (sha256(bios) !== SHA256) throw new Error('openbios.bin has changed (checksum mismatch)');
  await writeFile(biosFile, bios);
  await writeFile(join(outDir, 'openbios.license.txt'), await download(`${BASE}/COPYING.txt`));
  console.log('Saved public/bios/openbios.bin');
}
