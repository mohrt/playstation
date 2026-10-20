// Downloads a pinned build of JaCzekanski's ps1-tests (test programs for CPU,
// GTE, GPU, DMA, timers, MDEC, SPU and CD-ROM, with logs and VRAM screenshots
// from a real console) into tests/fixtures/ps1-tests/. npm test runs them when
// they are there.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const URL = 'https://github.com/JaCzekanski/ps1-tests/releases/download/build-158/tests.zip';
const SHA256 = '5de0e82854c1a511697a7ade381c2d778ec4b2fff4a7d7ac79e8098c35eb859b';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'ps1-tests');

if (existsSync(join(outDir, 'README.md'))) {
  console.log('tests/fixtures/ps1-tests is already there');
  process.exit(0);
}

const response = await fetch(URL);
if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
const zip = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(zip).digest('hex') !== SHA256) throw new Error('tests.zip has changed (checksum mismatch)');

const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (end < 0) throw new Error('not a zip file');
let offset = zip.readUInt32LE(end + 16);
let count = 0;
for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
  const method = zip.readUInt16LE(offset + 10);
  const size = zip.readUInt32LE(offset + 20);
  const nameLength = zip.readUInt16LE(offset + 28);
  const skip = nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  const local = zip.readUInt32LE(offset + 42);
  const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
  offset += 46 + skip;
  if (name.endsWith('/') || name.split('/').includes('..')) continue;
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + size);
  const target = join(outDir, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, method === 0 ? data : inflateRawSync(data));
  count++;
}
console.log(`Saved ${count} files to tests/fixtures/ps1-tests/`);
