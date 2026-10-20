/** A PS-EXE file: a 2K header ("PS-X EXE", entry point, load address and size) then the program. */
export interface PsExe {
  pc: number;
  gp: number;
  loadAddress: number;
  /** The program, as it goes into RAM. */
  text: Uint8Array;
  bssAddress: number;
  bssSize: number;
  /** Initial stack pointer, or 0 to keep the BIOS's. */
  stack: number;
}

export function isPsExe(bytes: Uint8Array): boolean {
  return bytes.length >= 0x800 && new TextDecoder().decode(bytes.subarray(0, 8)) === 'PS-X EXE';
}

export function parsePsExe(bytes: Uint8Array): PsExe {
  if (!isPsExe(bytes)) throw new Error('That file is not a PlayStation executable (no PS-X EXE header).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const size = Math.min(u32(0x1c), bytes.length - 0x800);
  const stackBase = u32(0x30);
  return {
    pc: u32(0x10),
    gp: u32(0x14),
    loadAddress: u32(0x18),
    text: bytes.subarray(0x800, 0x800 + size),
    bssAddress: u32(0x28),
    bssSize: u32(0x2c),
    stack: stackBase ? (stackBase + u32(0x34)) >>> 0 : 0,
  };
}
