import type { Scheduler } from '../scheduler';
import type { Gte } from './gte';

/** Memory as the CPU sees it. Accesses add their own wait states to the scheduler's clock. */
export interface CpuBus {
  fetch(address: number): number;
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
}

export const RESET_VECTOR = 0xbfc00000;

// COP0 cause codes.
const EXC_INTERRUPT = 0x0;
const EXC_ADDRESS_LOAD = 0x4;
const EXC_ADDRESS_STORE = 0x5;
const EXC_SYSCALL = 0x8;
const EXC_BREAK = 0x9;
const EXC_RESERVED = 0xa;
const EXC_COP_UNUSABLE = 0xb;
const EXC_OVERFLOW = 0xc;

const SR_IEC = 1 << 0;
const SR_ISC = 1 << 16;
const SR_BEV = 1 << 22;
const SR_CU2 = 1 << 30;
const CAUSE_IP2 = 1 << 10;

/** Cycles until MULT/DIV results can be read, by operation (the CPU stalls on MFHI/MFLO until then). */
const MULT_CYCLES = 9;
const DIV_CYCLES = 36;

/**
 * The R3000A: a MIPS I core with a load delay slot (a loaded register keeps
 * its old value for one more instruction), a branch delay slot, and COP0 for
 * exceptions and interrupts. COP2 is the GTE.
 */
export class Cpu {
  readonly r = new Int32Array(32);
  pc = RESET_VECTOR;
  nextPc = RESET_VECTOR + 4;
  hi = 0;
  lo = 0;

  // COP0
  sr = 0;
  cause = 0;
  epc = 0;
  badVaddr = 0;
  bpc = 0;
  bda = 0;
  dcic = 0;
  bdam = 0;
  bpcm = 0;
  jumpDest = 0;

  /** The load the previous instruction started, landing after this one. */
  private delayReg = 0;
  private delayValue = 0;
  /** The load this instruction starts. */
  private loadReg = 0;
  private loadValue = 0;
  /** The last instruction was a jump or branch, so this one is in its delay slot. */
  private branched = false;
  private inDelaySlot = false;
  private currentPc = 0;
  private hiLoReadyAt = 0;

  /** Called when the CPU reaches `hookPc` (side-loading an EXE when the BIOS starts its shell). */
  hookPc = -1;
  onHook: () => void = () => {};
  /** Called on BIOS function calls (jumps to 0xA0, 0xB0 and 0xC0), with the table address and function number. */
  onBiosCall: ((table: number, fn: number) => void) | null = null;

  constructor(
    private readonly bus: CpuBus,
    private readonly sched: Scheduler,
    readonly gte: Gte,
  ) {}

  reset(): void {
    this.r.fill(0);
    this.pc = RESET_VECTOR;
    this.nextPc = RESET_VECTOR + 4;
    this.hi = this.lo = 0;
    this.sr = SR_BEV;
    this.cause = this.epc = this.badVaddr = 0;
    this.bpc = this.bda = this.dcic = this.bdam = this.bpcm = this.jumpDest = 0;
    this.delayReg = this.delayValue = this.loadReg = this.loadValue = 0;
    this.branched = this.inDelaySlot = false;
    this.hiLoReadyAt = 0;
    this.gte.reset();
  }

  /** The interrupt controller's output, seen in COP0 cause bit 10. */
  setInterruptLine(pending: boolean): void {
    this.cause = pending ? this.cause | CAUSE_IP2 : this.cause & ~CAUSE_IP2;
  }

  /** Jumps somewhere directly (side-loading), as if by a jump with no delay slot. */
  jump(address: number): void {
    this.pc = address >>> 0;
    this.nextPc = (address + 4) >>> 0;
    this.branched = false;
    this.delayReg = this.loadReg = 0;
  }

  /** Runs until the scheduler's limit (the next event or the end of the slice). */
  run(): void {
    const sched = this.sched;
    while (sched.now < sched.limit) this.step();
  }

  step(): void {
    let pc = this.pc;
    if (pc === this.hookPc) {
      this.onHook();
      pc = this.pc;
    }
    if (this.onBiosCall && (pc & 0x1fffffff) < 0xc0) this.biosCall(pc & 0x1fffffff);
    this.currentPc = pc;
    this.inDelaySlot = this.branched;
    this.branched = false;

    if (this.sr & SR_IEC && this.sr & this.cause & 0xff00) {
      this.takeInterrupt();
      return;
    }
    if (pc & 3) {
      this.badVaddr = pc;
      this.exception(EXC_ADDRESS_LOAD);
      this.commitLoads();
      return;
    }
    const instruction = this.bus.fetch(pc);
    this.pc = this.nextPc;
    this.nextPc = (this.nextPc + 4) >>> 0;
    this.sched.now += 1;
    this.execute(instruction);
    this.commitLoads();
  }

  private commitLoads(): void {
    this.r[0] = 0;
    if ((this.delayReg | this.loadReg) === 0) return;
    if (this.delayReg !== 0) this.r[this.delayReg] = this.delayValue;
    this.delayReg = this.loadReg;
    this.delayValue = this.loadValue;
    this.loadReg = 0;
    this.r[0] = 0;
  }

  private biosCall(address: number): void {
    if (address === 0xa0 || address === 0xb0 || address === 0xc0) this.onBiosCall!(address, this.r[9] & 0xff);
  }

  private takeInterrupt(): void {
    // A GTE command interrupted this way still runs: the BIOS's handler skips over it when it returns.
    const next = this.bus.fetch(this.currentPc);
    if (next >>> 25 === 0x25) this.gte.command(next);
    if (this.delayReg !== 0) this.r[this.delayReg] = this.delayValue;
    this.delayReg = this.loadReg = 0;
    this.r[0] = 0;
    this.exception(EXC_INTERRUPT);
  }

  private exception(code: number, coprocessor = 0): void {
    const handler = this.sr & SR_BEV ? 0xbfc00180 : 0x80000080;
    const mode = this.sr & 0x3f;
    this.sr = (this.sr & ~0x3f) | ((mode << 2) & 0x3f);
    this.cause = (this.cause & ~0xb000007c) | (code << 2) | (coprocessor << 28);
    if (this.inDelaySlot) {
      this.epc = (this.currentPc - 4) >>> 0;
      this.cause |= 0x80000000;
    } else {
      this.epc = this.currentPc;
    }
    this.loadReg = 0;
    this.pc = handler;
    this.nextPc = handler + 4;
    this.branched = false;
  }

  /** A register write by an instruction: it wins over a load still landing in the same register. */
  private set(reg: number, value: number): void {
    this.r[reg] = value;
    if (reg === this.delayReg) this.delayReg = 0;
  }

  private load(reg: number, value: number): void {
    if (reg === 0) return;
    if (reg === this.delayReg) this.delayReg = 0;
    this.loadReg = reg;
    this.loadValue = value | 0;
  }

  private branch(target: number): void {
    this.nextPc = target >>> 0;
  }

  private waitHiLo(): void {
    if (this.sched.now < this.hiLoReadyAt) this.sched.now = this.hiLoReadyAt;
  }

  private execute(op: number): void {
    const r = this.r;
    const rs = (op >>> 21) & 31;
    const rt = (op >>> 16) & 31;
    switch (op >>> 26) {
      case 0x00:
        this.special(op, rs, rt);
        return;
      case 0x01: {
        // BLTZ, BGEZ, and the linking BLTZAL and BGEZAL (rt = 1000x).
        this.branched = true;
        const isBgez = (rt & 1) !== 0;
        const taken = isBgez ? r[rs] >= 0 : r[rs] < 0;
        if ((rt & 0x1e) === 0x10) this.set(31, this.nextPc | 0);
        if (taken) this.branch(this.pc + ((op << 16) >> 14));
        return;
      }
      case 0x02:
        this.branched = true;
        this.branch((this.pc & 0xf0000000) | ((op & 0x3ffffff) << 2));
        return;
      case 0x03:
        this.branched = true;
        this.set(31, this.nextPc | 0);
        this.branch((this.pc & 0xf0000000) | ((op & 0x3ffffff) << 2));
        return;
      case 0x04:
        this.branched = true;
        if (r[rs] === r[rt]) this.branch(this.pc + ((op << 16) >> 14));
        return;
      case 0x05:
        this.branched = true;
        if (r[rs] !== r[rt]) this.branch(this.pc + ((op << 16) >> 14));
        return;
      case 0x06:
        this.branched = true;
        if (r[rs] <= 0) this.branch(this.pc + ((op << 16) >> 14));
        return;
      case 0x07:
        this.branched = true;
        if (r[rs] > 0) this.branch(this.pc + ((op << 16) >> 14));
        return;
      case 0x08: {
        // ADDI traps on signed overflow.
        const a = r[rs];
        const b = (op << 16) >> 16;
        const sum = (a + b) | 0;
        if (((a ^ sum) & (b ^ sum)) < 0) {
          this.exception(EXC_OVERFLOW);
          return;
        }
        this.set(rt, sum);
        return;
      }
      case 0x09:
        this.set(rt, (r[rs] + ((op << 16) >> 16)) | 0);
        return;
      case 0x0a:
        this.set(rt, r[rs] < (op << 16) >> 16 ? 1 : 0);
        return;
      case 0x0b:
        this.set(rt, r[rs] >>> 0 < ((op << 16) >> 16) >>> 0 ? 1 : 0);
        return;
      case 0x0c:
        this.set(rt, r[rs] & (op & 0xffff));
        return;
      case 0x0d:
        this.set(rt, r[rs] | (op & 0xffff));
        return;
      case 0x0e:
        this.set(rt, r[rs] ^ (op & 0xffff));
        return;
      case 0x0f:
        this.set(rt, op << 16);
        return;
      case 0x10:
        this.cop0(op, rs, rt);
        return;
      case 0x11:
      case 0x13:
        // COP1 and COP3 don't exist: enabled, their instructions do nothing.
        this.missingCoprocessor((op >>> 26) & 3);
        return;
      case 0x12:
        this.cop2(op, rs, rt);
        return;
      case 0x20: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        this.load(rt, (this.bus.read8(address) << 24) >> 24);
        return;
      }
      case 0x21: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        if (address & 1) return this.addressError(address, EXC_ADDRESS_LOAD);
        this.load(rt, (this.bus.read16(address) << 16) >> 16);
        return;
      }
      case 0x22: {
        // LWL merges with the register's value, including a load still landing in it.
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        const current = rt === this.delayReg ? this.delayValue : r[rt];
        const word = this.bus.read32(address & ~3);
        let value: number;
        switch (address & 3) {
          case 0:
            value = (current & 0x00ffffff) | (word << 24);
            break;
          case 1:
            value = (current & 0x0000ffff) | (word << 16);
            break;
          case 2:
            value = (current & 0x000000ff) | (word << 8);
            break;
          default:
            value = word;
        }
        this.load(rt, value);
        return;
      }
      case 0x23: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        if (address & 3) return this.addressError(address, EXC_ADDRESS_LOAD);
        this.load(rt, this.bus.read32(address));
        return;
      }
      case 0x24: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        this.load(rt, this.bus.read8(address));
        return;
      }
      case 0x25: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        if (address & 1) return this.addressError(address, EXC_ADDRESS_LOAD);
        this.load(rt, this.bus.read16(address));
        return;
      }
      case 0x26: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        const current = rt === this.delayReg ? this.delayValue : r[rt];
        const word = this.bus.read32(address & ~3);
        let value: number;
        switch (address & 3) {
          case 0:
            value = word;
            break;
          case 1:
            value = (current & 0xff000000) | (word >>> 8);
            break;
          case 2:
            value = (current & 0xffff0000) | (word >>> 16);
            break;
          default:
            value = (current & 0xffffff00) | (word >>> 24);
        }
        this.load(rt, value);
        return;
      }
      case 0x28: {
        if (this.sr & SR_ISC) return;
        // Narrow stores put the whole register on the bus; I/O registers see all of it.
        this.bus.write8((r[rs] + ((op << 16) >> 16)) >>> 0, r[rt]);
        return;
      }
      case 0x29: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        if (address & 1) return this.addressError(address, EXC_ADDRESS_STORE);
        if (this.sr & SR_ISC) return;
        this.bus.write16(address, r[rt]);
        return;
      }
      case 0x2a: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        if (this.sr & SR_ISC) return;
        const aligned = address & ~3;
        const memory = this.bus.read32(aligned);
        const value = r[rt];
        let word: number;
        switch (address & 3) {
          case 0:
            word = (memory & 0xffffff00) | (value >>> 24);
            break;
          case 1:
            word = (memory & 0xffff0000) | (value >>> 16);
            break;
          case 2:
            word = (memory & 0xff000000) | (value >>> 8);
            break;
          default:
            word = value;
        }
        this.bus.write32(aligned >>> 0, word);
        return;
      }
      case 0x2b: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        if (address & 3) return this.addressError(address, EXC_ADDRESS_STORE);
        if (this.sr & SR_ISC) return;
        this.bus.write32(address, r[rt]);
        return;
      }
      case 0x2e: {
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        if (this.sr & SR_ISC) return;
        const aligned = address & ~3;
        const memory = this.bus.read32(aligned);
        const value = r[rt];
        let word: number;
        switch (address & 3) {
          case 0:
            word = value;
            break;
          case 1:
            word = (memory & 0x000000ff) | (value << 8);
            break;
          case 2:
            word = (memory & 0x0000ffff) | (value << 16);
            break;
          default:
            word = (memory & 0x00ffffff) | (value << 24);
        }
        this.bus.write32(aligned >>> 0, word);
        return;
      }
      case 0x32: {
        // LWC2
        if (!(this.sr & SR_CU2)) return this.exception(EXC_COP_UNUSABLE, 2);
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        if (address & 3) return this.addressError(address, EXC_ADDRESS_LOAD);
        this.gte.writeData(rt, this.bus.read32(address));
        return;
      }
      case 0x3a: {
        // SWC2
        if (!(this.sr & SR_CU2)) return this.exception(EXC_COP_UNUSABLE, 2);
        const address = (r[rs] + ((op << 16) >> 16)) >>> 0;
        if (address & 3) return this.addressError(address, EXC_ADDRESS_STORE);
        if (this.sr & SR_ISC) return;
        this.bus.write32(address, this.gte.readData(rt));
        return;
      }
      case 0x30:
      case 0x31:
      case 0x33:
      case 0x38:
      case 0x39:
      case 0x3b:
        // Loads and stores for COP0, COP1 and COP3, which have no registers for them.
        this.missingCoprocessor((op >>> 26) & 3);
        return;
      default:
        this.exception(EXC_RESERVED);
    }
  }

  /** An instruction for a coprocessor that isn't there: unusable unless enabled in SR, then a no-op. */
  private missingCoprocessor(coprocessor: number): void {
    if (!(this.sr & (1 << (28 + coprocessor)))) this.exception(EXC_COP_UNUSABLE, coprocessor);
  }

  private addressError(address: number, code: number): void {
    this.badVaddr = address;
    this.exception(code);
  }

  private special(op: number, rs: number, rt: number): void {
    const r = this.r;
    const rd = (op >>> 11) & 31;
    switch (op & 0x3f) {
      case 0x00:
        this.set(rd, r[rt] << ((op >>> 6) & 31));
        return;
      case 0x02:
        this.set(rd, r[rt] >>> ((op >>> 6) & 31));
        return;
      case 0x03:
        this.set(rd, r[rt] >> ((op >>> 6) & 31));
        return;
      case 0x04:
        this.set(rd, r[rt] << (r[rs] & 31));
        return;
      case 0x06:
        this.set(rd, r[rt] >>> (r[rs] & 31));
        return;
      case 0x07:
        this.set(rd, r[rt] >> (r[rs] & 31));
        return;
      case 0x08:
        this.branched = true;
        this.branch(r[rs]);
        return;
      case 0x09: {
        this.branched = true;
        const target = r[rs];
        this.set(rd, this.nextPc | 0);
        this.branch(target);
        return;
      }
      case 0x0c:
        this.exception(EXC_SYSCALL);
        return;
      case 0x0d:
        this.exception(EXC_BREAK);
        return;
      case 0x10:
        this.waitHiLo();
        this.set(rd, this.hi);
        return;
      case 0x11:
        this.hi = r[rs];
        return;
      case 0x12:
        this.waitHiLo();
        this.set(rd, this.lo);
        return;
      case 0x13:
        this.lo = r[rs];
        return;
      case 0x18:
        this.multiply(r[rs], r[rt], true);
        return;
      case 0x19:
        this.multiply(r[rs], r[rt], false);
        return;
      case 0x1a: {
        const n = r[rs];
        const d = r[rt];
        this.hiLoReadyAt = this.sched.now + DIV_CYCLES;
        if (d === 0) {
          this.hi = n;
          this.lo = n >= 0 ? -1 : 1;
        } else if (n === -0x80000000 && d === -1) {
          this.hi = 0;
          this.lo = n;
        } else {
          this.lo = (n / d) | 0;
          this.hi = n % d | 0;
        }
        return;
      }
      case 0x1b: {
        const n = r[rs] >>> 0;
        const d = r[rt] >>> 0;
        this.hiLoReadyAt = this.sched.now + DIV_CYCLES;
        if (d === 0) {
          this.hi = n | 0;
          this.lo = -1;
        } else {
          this.lo = Math.floor(n / d) | 0;
          this.hi = n % d | 0;
        }
        return;
      }
      case 0x20: {
        const a = r[rs];
        const b = r[rt];
        const sum = (a + b) | 0;
        if (((a ^ sum) & (b ^ sum)) < 0) return this.exception(EXC_OVERFLOW);
        this.set(rd, sum);
        return;
      }
      case 0x21:
        this.set(rd, (r[rs] + r[rt]) | 0);
        return;
      case 0x22: {
        const a = r[rs];
        const b = r[rt];
        const difference = (a - b) | 0;
        if (((a ^ b) & (a ^ difference)) < 0) return this.exception(EXC_OVERFLOW);
        this.set(rd, difference);
        return;
      }
      case 0x23:
        this.set(rd, (r[rs] - r[rt]) | 0);
        return;
      case 0x24:
        this.set(rd, r[rs] & r[rt]);
        return;
      case 0x25:
        this.set(rd, r[rs] | r[rt]);
        return;
      case 0x26:
        this.set(rd, r[rs] ^ r[rt]);
        return;
      case 0x27:
        this.set(rd, ~(r[rs] | r[rt]));
        return;
      case 0x2a:
        this.set(rd, r[rs] < r[rt] ? 1 : 0);
        return;
      case 0x2b:
        this.set(rd, r[rs] >>> 0 < r[rt] >>> 0 ? 1 : 0);
        return;
      default:
        this.exception(EXC_RESERVED);
    }
  }

  /** The 64-bit product into HI and LO, from 16-bit partial products (exact in doubles). */
  private multiply(a: number, b: number, signed: boolean): void {
    const ua = a >>> 0;
    const ub = b >>> 0;
    const a0 = ua & 0xffff;
    const a1 = ua >>> 16;
    const b0 = ub & 0xffff;
    const b1 = ub >>> 16;
    const p01 = a0 * b1;
    const p10 = a1 * b0;
    const middle = ((a0 * b0) >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    let high = a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + Math.floor(middle / 0x10000);
    if (signed) {
      if (a < 0) high -= ub;
      if (b < 0) high -= ua;
    }
    this.lo = Math.imul(a, b);
    this.hi = high | 0;
    this.hiLoReadyAt = this.sched.now + MULT_CYCLES;
  }

  private cop0(op: number, rs: number, rt: number): void {
    const rd = (op >>> 11) & 31;
    switch (rs) {
      case 0x00:
        this.load(rt, this.readCop0(rd));
        return;
      case 0x04:
        this.writeCop0(rd, this.r[rt]);
        return;
      case 0x10:
        if ((op & 0x3f) === 0x10) {
          // RFE pops the interrupt-enable/kernel-mode stack.
          this.sr = (this.sr & ~0xf) | ((this.sr >>> 2) & 0xf);
        }
        // Other COP0 operations (TLB instructions on other MIPS chips) do nothing.
        return;
      default:
        return;
    }
  }

  private readCop0(reg: number): number {
    switch (reg) {
      case 3:
        return this.bpc;
      case 5:
        return this.bda;
      case 6:
        return this.jumpDest;
      case 7:
        return this.dcic;
      case 8:
        return this.badVaddr;
      case 9:
        return this.bdam;
      case 11:
        return this.bpcm;
      case 12:
        return this.sr;
      case 13:
        return this.cause;
      case 14:
        return this.epc;
      case 15:
        return 0x00000002;
      default:
        return 0;
    }
  }

  private writeCop0(reg: number, value: number): void {
    switch (reg) {
      case 3:
        this.bpc = value;
        return;
      case 5:
        this.bda = value;
        return;
      case 7:
        this.dcic = value;
        return;
      case 9:
        this.bdam = value;
        return;
      case 11:
        this.bpcm = value;
        return;
      case 12:
        this.sr = value;
        return;
      case 13:
        // Only the two software interrupt bits can be written.
        this.cause = (this.cause & ~0x300) | (value & 0x300);
        return;
    }
  }

  private cop2(op: number, rs: number, rt: number): void {
    if (!(this.sr & SR_CU2)) return this.exception(EXC_COP_UNUSABLE, 2);
    if (op & (1 << 25)) {
      this.sched.now += this.gte.command(op);
      return;
    }
    const rd = (op >>> 11) & 31;
    switch (rs) {
      case 0x00:
        this.load(rt, this.gte.readData(rd));
        return;
      case 0x02:
        this.load(rt, this.gte.readControl(rd));
        return;
      case 0x04:
        this.gte.writeData(rd, this.r[rt]);
        return;
      case 0x06:
        this.gte.writeControl(rd, this.r[rt]);
        return;
      default:
        this.exception(EXC_RESERVED);
    }
  }
}
