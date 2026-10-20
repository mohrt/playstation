const POS = [0, 60, 115, 98];
const NEG = [0, 0, -52, -55];
const OUTPUT_RATE = 44100;

const clamp16 = (value: number) => (value < -0x8000 ? -0x8000 : value > 0x7fff ? 0x7fff : value);

/**
 * Decodes XA-ADPCM audio sectors: 18 sound groups of 128 bytes, each with 4
 * or 8 sound units of 28 samples, mono or stereo at 37.8 or 18.9 kHz. The
 * result is resampled to 44.1 kHz for the SPU.
 */
export class XaDecoder {
  private readonly previous = [new Int32Array(2), new Int32Array(2)];
  private readonly left = new Int16Array(4032);
  private readonly right = new Int16Array(4032);
  /** Resampling position between the last input sample and the next. */
  private phase = 0;
  private lastLeft = 0;
  private lastRight = 0;

  reset(): void {
    for (const p of this.previous) p.fill(0);
    this.phase = 0;
    this.lastLeft = this.lastRight = 0;
  }

  decode(sector: Uint8Array, emit: (left: number, right: number) => void): void {
    const coding = sector[19];
    const stereo = (coding & 0x03) === 1;
    const rate = coding & 0x04 ? 18900 : 37800;
    const eightBit = (coding & 0x30) === 0x10;
    let count = 0;
    let rightCount = 0;
    for (let group = 0; group < 18; group++) {
      const base = 24 + group * 128;
      const units = eightBit ? 4 : 8;
      for (let unit = 0; unit < units; unit++) {
        const header = sector[base + 4 + unit];
        let shift = header & 0x0f;
        if (shift > 12) shift = 9;
        const filter = (header >> 4) & 3;
        const channel = stereo ? unit & 1 : 0;
        const history = this.previous[channel];
        const out = channel ? this.right : this.left;
        for (let i = 0; i < 28; i++) {
          let raw: number;
          if (eightBit) raw = (sector[base + 16 + i * 4 + unit] << 24) >> 16;
          else {
            const byte = sector[base + 16 + i * 4 + (unit >> 1)];
            raw = ((unit & 1 ? byte >> 4 : byte & 0x0f) << 28) >> 16;
          }
          const sample = clamp16((raw >> shift) + ((history[0] * POS[filter] + history[1] * NEG[filter] + 32) >> 6));
          history[1] = history[0];
          history[0] = sample;
          if (channel) out[rightCount++] = sample;
          else out[count++] = sample;
        }
      }
    }
    if (!stereo) this.right.set(this.left.subarray(0, count));
    this.resample(count, rate, emit);
  }

  /** Linear interpolation from `rate` up to 44.1 kHz. */
  private resample(count: number, rate: number, emit: (left: number, right: number) => void): void {
    const step = rate / OUTPUT_RATE;
    let phase = this.phase;
    let i = 0;
    while (i < count) {
      const left0 = i === 0 ? this.lastLeft : this.left[i - 1];
      const right0 = i === 0 ? this.lastRight : this.right[i - 1];
      emit(Math.round(left0 + (this.left[i] - left0) * phase), Math.round(right0 + (this.right[i] - right0) * phase));
      phase += step;
      while (phase >= 1 && i < count) {
        phase -= 1;
        i++;
      }
    }
    this.phase = phase;
    this.lastLeft = this.left[count - 1] ?? 0;
    this.lastRight = this.right[count - 1] ?? 0;
  }
}
