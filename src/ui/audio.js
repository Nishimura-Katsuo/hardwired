// Procedural sound. No assets: everything is noise and oscillators through a
// compressor, panned and attenuated from the broadcast camera's position.
const MAX_VOICES = 24;

export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.voices = 0;
    this.crowdLevel = 0;
  }

  /** Must be called from a user gesture. */
  start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.ratio.value = 8;
    this.master.connect(limiter).connect(ctx.destination);

    const length = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    const crowd = ctx.createBufferSource();
    crowd.buffer = this.noise;
    crowd.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 650;
    band.Q.value = 0.5;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.03;
    crowd.connect(band).connect(this.crowdGain).connect(this.master);
    crowd.start();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.7;
    return this.muted;
  }

  blast({ gain, pan = 0, freq, duration, type = 'lowpass', q = 0.8, rate = 1 }) {
    if (!this.ctx || this.voices >= MAX_VOICES) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.25), now + duration);
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, now);
    amp.gain.exponentialRampToValueAtTime(0.0008, now + duration);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    src.connect(filter).connect(amp).connect(panner).connect(this.master);
    src.start(now, Math.random() * 1.5, duration + 0.02);
    this.voices++;
    src.onended = () => this.voices--;
  }

  tone(freq, duration, gain, type = 'square', delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, now);
    amp.gain.exponentialRampToValueAtTime(0.0008, now + duration);
    osc.connect(amp).connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /** Reacts to one effect-timeline event. `spot` gives distance and pan from camera. */
  event(e, spot, speed) {
    if (!this.ctx) return;
    if (e.type === 'shot') {
      const { gain, pan } = spot(e.fx, e.fy, e.fz);
      this.blast({ gain: gain * 0.42, pan, freq: e.overcharged ? 4200 : 3000, duration: 0.14 / Math.max(0.5, speed), rate: speed });
      this.blast({ gain: gain * 0.5, pan, freq: 240, duration: 0.11 / Math.max(0.5, speed), rate: 0.5 * speed });
    } else if (e.type === 'hit') {
      const { gain, pan } = spot(e.x, e.y, e.z);
      this.blast({ gain: Math.max(gain, 0.12) * 0.4, pan, freq: e.head ? 6200 : 3800, duration: 0.06, type: 'bandpass', q: 7 });
    } else if (e.type === 'kill') {
      const { gain, pan } = spot(e.x, e.y, e.z);
      this.blast({ gain: gain * 1.1, pan, freq: 900, duration: 0.5 / Math.max(0.5, speed) });
      this.blast({ gain: gain * 0.5, pan, freq: 5200, duration: 0.3, type: 'highpass' });
    } else if (e.type === 'overchargeUp') {
      [392, 494, 587].forEach((f, i) => this.tone(f, 0.32, 0.05, 'triangle', i * 0.09));
    } else if (e.type === 'overchargeTaken') {
      [587, 784, 1175].forEach((f, i) => this.tone(f, 0.28, 0.06, 'square', i * 0.06));
    } else if (e.type === 'matchEnd') {
      [262, 330, 392, 523].forEach((f, i) => this.tone(f, 0.7, 0.07, 'sawtooth', i * 0.14));
    }
  }

  cheer(amount) {
    this.crowdLevel = Math.min(1, this.crowdLevel + amount);
  }

  whoosh() {
    this.blast({ gain: 0.32, freq: 2600, duration: 0.5, type: 'bandpass', q: 1.2 });
    this.tone(880, 0.09, 0.04, 'square', 0.28);
    this.tone(1320, 0.11, 0.04, 'square', 0.36);
  }

  update(dt) {
    this.crowdLevel *= Math.exp(-dt / 1.3);
    if (this.crowdGain) this.crowdGain.gain.setTargetAtTime(0.03 + this.crowdLevel * 0.2, this.ctx.currentTime, 0.1);
  }
}
