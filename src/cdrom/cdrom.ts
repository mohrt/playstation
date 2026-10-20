import { bcd, Disc, fromBcd, LEAD_IN, msf, SECTOR_SIZE, type DiscRegion } from '../disc/disc';
import { Irq, type Interrupts } from '../irq';
import { CPU_HZ, TimedEvent, type Scheduler } from '../scheduler';
import type { CdAudioSource } from '../spu/spu';
import { XaDecoder } from './xa';

const STAT_ERROR = 0x01;
const STAT_MOTOR = 0x02;
const STAT_ID_ERROR = 0x08;
const STAT_SHELL_OPEN = 0x10;
const STAT_READING = 0x20;
const STAT_SEEKING = 0x40;
const STAT_PLAYING = 0x80;

const MODE_CDDA = 0x01;
const MODE_AUTO_PAUSE = 0x02;
const MODE_REPORT = 0x04;
const MODE_XA_FILTER = 0x08;
const MODE_SECTOR_2340 = 0x20;
const MODE_XA_ADPCM = 0x40;
const MODE_DOUBLE_SPEED = 0x80;

const ACK_DELAY = 25_000;
const ACK_DELAY_NO_DISC = 15_000;
const INIT_ACK_DELAY = 80_000;
const GETID_DELAY = 0x4a00;
const SECTOR_CYCLES = CPU_HZ / 75;
const MIN_SEEK_CYCLES = 20_000;
/** How long the lid stays open when discs are swapped. */
const LID_OPEN_CYCLES = CPU_HZ;

/** The ring buffer of CD audio (CD-DA and XA) waiting for the SPU, in stereo samples. */
const AUDIO_BUFFER = 44100;

type DriveState = 'idle' | 'seeking' | 'reading' | 'playing';
type DriveAction = 'none' | 'seek-done' | 'start-reading' | 'start-playing' | 'read' | 'play';
/** Slow commands' second responses (kept as data, so save states can hold them). */
type SecondResponse = 'none' | 'stat' | 'motor-on' | 'motor-off' | 'init' | 'id' | 'id-audio' | 'subq';

interface PendingInterrupt {
  type: number;
  response: number[];
  /** The sector an INT1 announces: it becomes the one the data FIFO loads when the INT1 is shown. */
  sector?: Uint8Array;
}

/** Sectors read but not yet announced; older ones are lost if the CPU falls this far behind. */
const SECTOR_BUFFERS = 4;

/**
 * The CD-ROM controller. Commands go in through the command and parameter
 * registers; replies come back as interrupts (INT3 acknowledges a command,
 * INT2 completes a slow one, INT1 delivers each sector read, INT4 ends
 * playback, INT5 is an error) each with a few response bytes. One interrupt
 * is shown at a time: the next waits until the CPU acknowledges it.
 */
export class CdRom implements CdAudioSource {
  disc: Disc | null = null;
  region: DiscRegion = 'ntsc-u';
  private shellOpen = false;

  index = 0;
  private readonly params: number[] = [];
  private response = new Uint8Array(16);
  private responseLength = 0;
  private responsePosition = 0;
  interruptEnable = 0;
  interruptFlag = 0;
  private readonly queue: PendingInterrupt[] = [];
  private busy = false;
  private command = 0;
  private commandParams: number[] = [];

  mode = 0;
  private motorOn = false;
  private state: DriveState = 'idle';
  private errorStat = 0;
  /** Where the next Setloc said to go (an LBA), until a read or seek uses it. */
  private setlocTarget = 0;
  private setlocPending = false;
  /** The next sector the head reads. */
  position = 0;
  private filterFile = 0;
  private filterChannel = 0;
  private muted = false;
  private adpcmMuted = false;
  private reportCount = 0;
  private playTrackEnd = Infinity;

  /** The last data sector read, waiting to be loaded into the data FIFO. */
  private readonly sector = new Uint8Array(SECTOR_SIZE);
  private sectorReady = false;
  private readonly lastHeader = new Uint8Array(8);
  private readonly data = new Uint8Array(SECTOR_SIZE);
  private dataLength = 0;
  private dataPosition = 0;
  private readonly readBuffer = new Uint8Array(SECTOR_SIZE);

  // Volume from CD left/right to SPU left/right (0x80 = 100%), and the values waiting for "apply".
  private volume = [0x80, 0x00, 0x00, 0x80];
  private pendingVolume = [0x80, 0x00, 0x00, 0x80];
  private readonly audio = new Int16Array(AUDIO_BUFFER * 2);
  private audioRead = 0;
  private audioWrite = 0;
  private readonly xa = new XaDecoder();

  private readonly ackEvent: TimedEvent;
  private readonly secondEvent: TimedEvent;
  private readonly driveEvent: TimedEvent;
  private readonly deliverEvent: TimedEvent;
  private readonly lidEvent: TimedEvent;
  /** The disc going in while the lid is open for a swap. */
  private nextDisc: Disc | null = null;
  private nextRegion: DiscRegion = 'ntsc-u';
  private secondResponse: SecondResponse = 'none';
  /** What the drive does when its next event comes (seeks end, sectors are read). */
  private driveAction: DriveAction = 'none';

  constructor(
    private readonly sched: Scheduler,
    private readonly irq: Interrupts,
  ) {
    this.ackEvent = sched.add(new TimedEvent('cdrom-ack', () => this.acknowledgeCommand()));
    this.secondEvent = sched.add(new TimedEvent('cdrom-second', () => this.sendSecond()));
    this.driveEvent = sched.add(new TimedEvent('cdrom-drive', () => this.driveTick()));
    this.deliverEvent = sched.add(new TimedEvent('cdrom-deliver', () => this.deliver()));
    this.lidEvent = sched.add(new TimedEvent('cdrom-lid', () => this.closeLid()));
  }

  reset(): void {
    this.index = 0;
    this.params.length = 0;
    this.responseLength = this.responsePosition = 0;
    this.interruptEnable = this.interruptFlag = 0;
    this.queue.length = 0;
    this.busy = false;
    this.mode = 0;
    this.motorOn = this.disc !== null;
    this.shellOpen = false;
    this.state = 'idle';
    this.errorStat = 0;
    this.setlocTarget = this.position = 0;
    this.setlocPending = false;
    this.filterFile = this.filterChannel = 0;
    this.muted = this.adpcmMuted = false;
    this.sectorReady = false;
    this.dataLength = this.dataPosition = 0;
    this.volume = [0x80, 0x00, 0x00, 0x80];
    this.pendingVolume = [0x80, 0x00, 0x00, 0x80];
    this.audioRead = this.audioWrite = 0;
    this.xa.reset();
    for (const event of [this.ackEvent, this.secondEvent, this.driveEvent, this.deliverEvent, this.lidEvent]) this.sched.cancel(event);
    if (this.nextDisc) this.closeLid();
    this.secondResponse = 'none';
    this.driveAction = 'none';
  }

  /** Puts a disc in (or takes it out), as if the lid was opened and closed. */
  insertDisc(disc: Disc | null, region: DiscRegion = 'ntsc-u'): void {
    this.disc = disc;
    this.region = region;
    this.stopDrive();
    this.motorOn = disc !== null;
    this.shellOpen = true;
    this.position = 0;
  }

  /**
   * Changes discs while the console runs: the lid opens (the drive stops, and
   * the status shows it open), and a second later closes on the new disc. The
   * "lid open" status bit stays set until the game reads the status, which is
   * how games notice a disc was changed.
   */
  swapDisc(disc: Disc, region: DiscRegion): void {
    this.disc = null;
    this.stopDrive();
    this.motorOn = false;
    this.shellOpen = true;
    this.errorStat = 0;
    this.queue.length = 0;
    this.nextDisc = disc;
    this.nextRegion = region;
    this.sched.schedule(this.lidEvent, LID_OPEN_CYCLES);
  }

  private closeLid(): void {
    if (!this.nextDisc) return;
    this.disc = this.nextDisc;
    this.region = this.nextRegion;
    this.nextDisc = null;
    this.motorOn = true;
    this.position = 0;
  }

  private get stat(): number {
    let stat = this.errorStat;
    if (this.motorOn) stat |= STAT_MOTOR;
    if (this.shellOpen || !this.disc) stat |= STAT_SHELL_OPEN;
    if (this.state === 'reading') stat |= STAT_READING;
    if (this.state === 'seeking') stat |= STAT_SEEKING;
    if (this.state === 'playing') stat |= STAT_PLAYING;
    return stat;
  }

  // --- Registers --------------------------------------------------------------------

  read(register: number): number {
    switch (register) {
      case 0: {
        let status = this.index;
        if (this.params.length === 0) status |= 0x08;
        if (this.params.length < 16) status |= 0x10;
        if (this.responsePosition < this.responseLength) status |= 0x20;
        if (this.dataPosition < this.dataLength) status |= 0x40;
        if (this.busy) status |= 0x80;
        return status;
      }
      case 1: {
        if (this.responsePosition >= this.responseLength) return 0;
        return this.response[this.responsePosition++];
      }
      case 2:
        return this.readDataByte();
      default:
        return this.index & 1 ? this.interruptFlag | 0xe0 : this.interruptEnable | 0xe0;
    }
  }

  write(register: number, value: number): void {
    value &= 0xff;
    switch ((register << 2) | this.index) {
      case 0x0:
      case 0x1:
      case 0x2:
      case 0x3:
        this.index = value & 3;
        return;
      case 0x4:
        this.startCommand(value);
        return;
      case 0x7:
        this.pendingVolume[3] = value;
        return;
      case 0x8:
        if (this.params.length < 16) this.params.push(value);
        return;
      case 0x9:
        this.interruptEnable = value & 0x1f;
        this.updateIrq();
        return;
      case 0xa:
        this.pendingVolume[0] = value;
        return;
      case 0xb:
        this.pendingVolume[2] = value;
        return;
      case 0xc:
        // "Want data" loads the current sector once the FIFO is empty; while it still holds data, it's kept.
        if (value & 0x80) {
          if (this.dataPosition >= this.dataLength) this.loadData();
        } else {
          this.dataLength = this.dataPosition = 0;
        }
        return;
      case 0xd:
        this.interruptFlag &= ~(value & 0x1f);
        if (value & 0x40) this.params.length = 0;
        if (this.interruptFlag === 0 && this.queue.length > 0) this.sched.schedule(this.deliverEvent, 1000);
        this.updateIrq();
        return;
      case 0xe:
        this.pendingVolume[1] = value;
        return;
      case 0xf:
        this.adpcmMuted = (value & 0x01) !== 0;
        if (value & 0x20) this.volume = [...this.pendingVolume];
        return;
    }
  }

  private updateIrq(): void {
    if (this.interruptFlag & this.interruptEnable) this.irq.raise(Irq.CdRom);
  }

  // --- Data FIFO --------------------------------------------------------------------

  private loadData(): void {
    if (!this.sectorReady) return;
    if (this.mode & MODE_SECTOR_2340) {
      this.data.set(this.sector.subarray(12, 12 + 2340));
      this.dataLength = 2340;
    } else {
      this.data.set(this.sector.subarray(24, 24 + 2048));
      this.dataLength = 2048;
    }
    this.dataPosition = 0;
  }

  private readDataByte(): number {
    if (this.dataPosition >= this.dataLength) return 0;
    return this.data[this.dataPosition++];
  }

  /** DMA channel 3 reads the data FIFO a word at a time. */
  dmaRead(): number {
    const b0 = this.readDataByte();
    const b1 = this.readDataByte();
    const b2 = this.readDataByte();
    const b3 = this.readDataByte();
    return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
  }

  // --- Interrupts -------------------------------------------------------------------

  private push(type: number, response: number[], sector?: Uint8Array): void {
    if (type === 1) {
      const waiting = this.queue.filter((item) => item.type === 1);
      if (waiting.length >= SECTOR_BUFFERS) this.queue.splice(this.queue.indexOf(waiting[0]), 1);
    }
    this.queue.push({ type, response, sector });
    if (this.interruptFlag === 0) this.deliver();
  }

  private deliver(): void {
    if (this.interruptFlag !== 0) return;
    const next = this.queue.shift();
    if (!next) return;
    this.response.fill(0);
    this.response.set(next.response.slice(0, 16));
    this.responseLength = next.response.length;
    this.responsePosition = 0;
    if (next.sector) {
      this.sector.set(next.sector);
      this.lastHeader.set(next.sector.subarray(12, 20));
      this.sectorReady = true;
    }
    this.interruptFlag = next.type;
    this.updateIrq();
  }

  // --- Commands ---------------------------------------------------------------------

  private startCommand(command: number): void {
    this.command = command;
    this.commandParams = this.params.splice(0);
    this.busy = true;
    let delay = this.disc ? ACK_DELAY : ACK_DELAY_NO_DISC;
    if (command === 0x0a) delay = INIT_ACK_DELAY;
    this.sched.schedule(this.ackEvent, delay);
  }

  private error(code: number): void {
    this.push(5, [this.stat | STAT_ERROR, code]);
  }

  /** Schedules the command's second response, which is worked out when it is sent. */
  private second(delay: number, kind: SecondResponse): void {
    this.secondResponse = kind;
    this.sched.schedule(this.secondEvent, delay);
  }

  private sendSecond(): void {
    const kind = this.secondResponse;
    this.secondResponse = 'none';
    switch (kind) {
      case 'stat':
        this.push(2, [this.stat]);
        return;
      case 'motor-on':
        this.motorOn = true;
        this.push(2, [this.stat]);
        return;
      case 'motor-off':
        this.motorOn = false;
        this.push(2, [this.stat]);
        return;
      case 'init':
        this.motorOn = this.disc !== null;
        this.push(2, [this.stat]);
        return;
      case 'id': {
        const letter = this.region === 'pal' ? 0x45 : this.region === 'ntsc-j' ? 0x49 : 0x41;
        this.push(2, [STAT_MOTOR, 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, letter]);
        return;
      }
      case 'id-audio':
        this.push(5, [this.stat | STAT_ID_ERROR, 0x90, 0x00, 0, 0, 0, 0, 0]);
        return;
      case 'subq':
        this.push(2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        return;
    }
  }

  private needDisc(): boolean {
    if (this.disc) return true;
    this.push(5, [STAT_ID_ERROR | STAT_SHELL_OPEN | STAT_ERROR, 0x80]);
    return false;
  }

  private acknowledgeCommand(): void {
    this.busy = false;
    const p = this.commandParams;
    switch (this.command) {
      case 0x01: {
        const stat = this.stat;
        // Reading the status after the lid was closed clears the "lid open" bit.
        if (this.disc) this.shellOpen = false;
        this.errorStat = 0;
        this.push(3, [stat]);
        return;
      }
      case 0x02:
        this.setlocTarget = Math.max(0, (fromBcd(p[0] ?? 0) * 60 + fromBcd(p[1] ?? 0)) * 75 + fromBcd(p[2] ?? 0) - LEAD_IN);
        this.setlocPending = true;
        this.push(3, [this.stat]);
        return;
      case 0x03:
        return this.play(p[0]);
      case 0x04:
      case 0x05:
        this.position = Math.max(0, this.position + (this.command === 0x04 ? 75 : -75));
        this.push(3, [this.stat]);
        return;
      case 0x06:
      case 0x1b:
        if (!this.needDisc()) return;
        this.push(3, [this.stat]);
        this.startReading();
        return;
      case 0x07:
        this.push(3, [this.stat]);
        this.second(0x10000, 'motor-on');
        return;
      case 0x08: {
        this.push(3, [this.stat]);
        const wasSpinning = this.motorOn;
        this.stopDrive();
        this.second(wasSpinning ? 0x100000 : 0x1000, 'motor-off');
        return;
      }
      case 0x09: {
        this.push(3, [this.stat]);
        const wasActive = this.state !== 'idle';
        this.stopDrive();
        this.second(wasActive ? this.sectorCycles() : 0x1df2, 'stat');
        return;
      }
      case 0x0a:
        this.push(3, [this.stat]);
        this.stopDrive();
        this.mode = MODE_SECTOR_2340;
        this.second(0x13cce, 'init');
        return;
      case 0x0b:
        this.muted = true;
        this.push(3, [this.stat]);
        return;
      case 0x0c:
        this.muted = false;
        this.push(3, [this.stat]);
        return;
      case 0x0d:
        this.filterFile = p[0] ?? 0;
        this.filterChannel = p[1] ?? 0;
        this.push(3, [this.stat]);
        return;
      case 0x0e:
        this.mode = p[0] ?? 0;
        this.push(3, [this.stat]);
        return;
      case 0x0f:
        this.push(3, [this.stat, this.mode, 0, this.filterFile, this.filterChannel]);
        return;
      case 0x10:
        this.push(3, [...this.lastHeader]);
        return;
      case 0x11:
        this.push(3, this.locationP());
        return;
      case 0x12:
        this.push(3, [this.stat]);
        this.second(0x10000, 'stat');
        return;
      case 0x13: {
        if (!this.needDisc()) return;
        const tracks = this.disc!.tracks;
        this.push(3, [this.stat, bcd(tracks[0].number), bcd(tracks[tracks.length - 1].number)]);
        return;
      }
      case 0x14: {
        if (!this.needDisc()) return;
        const number = fromBcd(p[0] ?? 0);
        const disc = this.disc!;
        const track = number === 0 ? null : disc.tracks.find((t) => t.number === number);
        if (number !== 0 && !track) return this.error(0x10);
        const [m, s] = msf((track ? track.start : disc.leadOut) + LEAD_IN);
        this.push(3, [this.stat, bcd(m), bcd(s)]);
        return;
      }
      case 0x15:
      case 0x16:
        if (!this.needDisc()) return;
        this.push(3, [this.stat]);
        this.seek('seek-done');
        return;
      case 0x19:
        return this.test(p[0] ?? 0);
      case 0x1a:
        return this.getId();
      case 0x1c:
        this.push(3, [this.stat]);
        return;
      case 0x1d:
        this.push(3, [this.stat]);
        this.second(0x2000, 'subq');
        return;
      case 0x1e:
        if (!this.needDisc()) return;
        this.push(3, [this.stat]);
        this.second(0x80000, 'stat');
        return;
      default:
        this.error(0x40);
    }
  }

  private test(sub: number): void {
    switch (sub) {
      case 0x20:
        this.push(3, [0x94, 0x09, 0x19, 0xc0]);
        return;
      case 0x04:
      case 0x05:
        this.push(3, [this.stat, 0]);
        return;
      default:
        this.push(3, [this.stat]);
    }
  }

  private getId(): void {
    if (!this.disc) {
      this.push(5, [STAT_ID_ERROR | STAT_SHELL_OPEN | STAT_ERROR, 0x80]);
      return;
    }
    this.push(3, [this.stat]);
    const audioOnly = this.disc.tracks.every((track) => track.audio);
    this.second(GETID_DELAY, audioOnly ? 'id-audio' : 'id');
  }

  private locationP(): number[] {
    const disc = this.disc;
    if (!disc) return [0, 0, 0, 0, 0, 0, 0, 0];
    const lba = Math.max(0, this.position - 1);
    const track = disc.trackAt(lba);
    const relative = Math.abs(lba - track.start);
    const [rm, rs, rf] = msf(relative);
    const [am, as, af] = msf(lba + LEAD_IN);
    const index = lba < track.start ? 0 : 1;
    return [bcd(track.number), bcd(index), bcd(rm), bcd(rs), bcd(rf), bcd(am), bcd(as), bcd(af)];
  }

  // --- The drive --------------------------------------------------------------------

  private sectorCycles(): number {
    return Math.round(this.mode & MODE_DOUBLE_SPEED ? SECTOR_CYCLES / 2 : SECTOR_CYCLES);
  }

  private stopDrive(): void {
    this.state = 'idle';
    this.sched.cancel(this.driveEvent);
    this.driveAction = 'none';
  }

  /** Moves the head to the Setloc target (if one is waiting), then goes on to `next`. */
  private seek(next: DriveAction): void {
    const target = this.setlocPending ? this.setlocTarget : this.position;
    this.setlocPending = false;
    const distance = Math.abs(target - this.position);
    this.position = target;
    this.motorOn = true;
    this.state = 'seeking';
    this.driveAction = next;
    this.sched.schedule(this.driveEvent, MIN_SEEK_CYCLES + Math.min(1_000_000, distance * 20));
  }

  private startReading(): void {
    if (this.setlocPending || this.state === 'idle') this.seek('start-reading');
    else this.beginReading();
  }

  private beginReading(): void {
    this.state = 'reading';
    this.driveAction = 'read';
    this.sched.schedule(this.driveEvent, this.sectorCycles());
  }

  private driveTick(): void {
    switch (this.driveAction) {
      case 'seek-done':
        this.state = 'idle';
        this.driveAction = 'none';
        this.push(2, [this.stat]);
        return;
      case 'start-reading':
        this.beginReading();
        return;
      case 'start-playing':
        this.beginPlaying();
        return;
      case 'read':
        this.readSector();
        return;
      case 'play':
        this.playSector();
        return;
    }
  }

  private readSector(): void {
    const disc = this.disc;
    if (!disc || this.state !== 'reading') return;
    this.sched.schedule(this.driveEvent, this.sectorCycles());
    const sector = this.readBuffer;
    if (!disc.readSector(this.position, sector)) {
      this.stopDrive();
      this.push(4, [this.stat]);
      return;
    }
    const lba = this.position++;
    if (disc.trackAt(lba).audio) {
      if (this.mode & MODE_CDDA) this.playAudioSector(sector);
      return;
    }
    const file = sector[16];
    const channel = sector[17];
    const submode = sector[18];
    const realtimeAudio = (submode & 0x44) === 0x44;
    if (this.mode & MODE_XA_ADPCM && realtimeAudio) {
      const matches = !(this.mode & MODE_XA_FILTER) || (file === this.filterFile && channel === this.filterChannel);
      if (matches && !this.muted && !this.adpcmMuted) this.xa.decode(sector, (left, right) => this.pushAudio(left, right));
      return;
    }
    if (this.mode & MODE_XA_FILTER && submode & 0x04) return;
    this.push(1, [this.stat], sector.slice());
  }

  // --- CD audio ---------------------------------------------------------------------

  private play(trackParam: number | undefined): void {
    if (!this.needDisc()) return;
    const disc = this.disc!;
    const number = trackParam ? fromBcd(trackParam) : 0;
    const track = number ? disc.tracks.find((t) => t.number === number) : null;
    if (track) {
      this.setlocTarget = track.start;
      this.setlocPending = true;
    }
    this.push(3, [this.stat]);
    if (this.setlocPending || this.state === 'idle') this.seek('start-playing');
    else this.beginPlaying();
  }

  private beginPlaying(): void {
    if (!this.disc) return;
    const current = this.disc.trackAt(this.position);
    this.playTrackEnd = current.start + current.length;
    this.state = 'playing';
    this.reportCount = 0;
    this.driveAction = 'play';
    this.sched.schedule(this.driveEvent, this.sectorCycles());
  }

  private playSector(): void {
    const disc = this.disc;
    if (!disc || this.state !== 'playing') return;
    this.sched.schedule(this.driveEvent, this.sectorCycles());
    if (this.mode & MODE_AUTO_PAUSE && this.position >= this.playTrackEnd) {
      this.stopDrive();
      this.push(4, [this.stat]);
      return;
    }
    if (!disc.readSector(this.position, this.readBuffer) || this.position >= disc.leadOut) {
      this.stopDrive();
      this.push(4, [this.stat]);
      return;
    }
    this.position++;
    this.playAudioSector(this.readBuffer);
    if (this.mode & MODE_REPORT && ++this.reportCount % 10 === 0) {
      const location = this.locationP();
      const absolute = (this.reportCount / 10) & 1;
      const report = absolute ? [location[5], location[6] | 0x80, location[7]] : [location[2], location[3], location[4]];
      this.push(1, [this.stat, location[0], location[1], ...report, 0, 0]);
    }
  }

  private playAudioSector(sector: Uint8Array): void {
    if (this.muted) return;
    for (let i = 0; i < SECTOR_SIZE; i += 4) {
      const left = (sector[i] | (sector[i + 1] << 8)) << 16 >> 16;
      const right = (sector[i + 2] | (sector[i + 3] << 8)) << 16 >> 16;
      this.pushAudio(left, right);
    }
  }

  /** Queues a 44.1 kHz stereo sample for the SPU, through the CD-to-SPU volume matrix. */
  private pushAudio(left: number, right: number): void {
    const [ll, lr, rl, rr] = this.volume;
    const outLeft = (left * ll + right * rl) >> 7;
    const outRight = (left * lr + right * rr) >> 7;
    const next = (this.audioWrite + 2) % this.audio.length;
    if (next === this.audioRead) this.audioRead = (this.audioRead + 2) % this.audio.length;
    this.audio[this.audioWrite] = Math.max(-0x8000, Math.min(0x7fff, outLeft));
    this.audio[this.audioWrite + 1] = Math.max(-0x8000, Math.min(0x7fff, outRight));
    this.audioWrite = next;
  }

  nextSample(out: Int16Array): void {
    if (this.audioRead === this.audioWrite) {
      out[0] = out[1] = 0;
      return;
    }
    out[0] = this.audio[this.audioRead];
    out[1] = this.audio[this.audioRead + 1];
    this.audioRead = (this.audioRead + 2) % this.audio.length;
  }
}
