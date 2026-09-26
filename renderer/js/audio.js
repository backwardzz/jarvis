// Microphone capture with voice-activity detection, and the processed "JARVIS" voice output.
const TARGET_RATE = 16000;
const FRAME = 512; // 32 ms at 16 kHz

const TAP_WORKLET = `
class JarvisTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('jarvis-tap', JarvisTap);
`;

function resampleTo16k(input, rate) {
  if (rate === TARGET_RATE) return input;
  const ratio = rate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const f = pos - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

export class Microphone {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.onFrame = null;
    this.pending = new Float32Array(0);
  }

  get open() {
    return !!this.ctx;
  }

  async start() {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let ctx;
    let src;
    try {
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
      src = ctx.createMediaStreamSource(this.stream);
    } catch {
      ctx?.close();
      ctx = new AudioContext();
      src = ctx.createMediaStreamSource(this.stream);
    }
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const tap = new AudioWorkletNode(ctx, 'jarvis-tap');
    const rate = ctx.sampleRate;
    tap.port.onmessage = (e) => this.feed(resampleTo16k(e.data, rate));
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.55;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.analyser);
    src.connect(tap);
    tap.connect(mute).connect(ctx.destination);
    this.ctx = ctx;
  }

  feed(samples) {
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let off = 0;
    while (merged.length - off >= FRAME) {
      this.onFrame?.(merged.subarray(off, off + FRAME).slice());
      off += FRAME;
    }
    this.pending = merged.slice(off);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.pending = new Float32Array(0);
  }
}

/**
 * Energy-based voice activity detector with an adaptive noise floor.
 * mode 'command': one utterance after activation. mode 'wake': endless segmentation.
 */
export class Vad {
  constructor({ onStart, onEnd, onTimeout } = {}) {
    Object.assign(this, { onStart, onEnd, onTimeout });
    this.noise = 0.006;
    this.mode = null;
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.above = 0;
    this.silence = 0;
    this.voiced = 0;
    this.segment = [];
    this.preroll = [];
    this.waited = 0;
  }

  begin(mode, opts = {}) {
    this.mode = mode;
    this.opts = {
      endSilenceMs: mode === 'wake' ? 750 : 1050,
      noSpeechMs: 8000,
      maxMs: 25000,
      minSpeechMs: 320,
      ...opts,
    };
    this.reset();
  }

  cancel() {
    this.mode = null;
    this.reset();
  }

  /** Force end of the current utterance (button released / pressed again). */
  finish() {
    if (this.mode && this.speaking) this.close(true);
    else this.cancel();
  }

  push(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const ms = (frame.length / TARGET_RATE) * 1000;
    const thr = Math.max(0.014, this.noise * 3.2);
    if (!this.speaking) {
      if (rms < thr) this.noise = Math.min(0.03, this.noise * 0.985 + rms * 0.015);
    }
    if (!this.mode) return;

    if (!this.speaking) {
      this.preroll.push(frame);
      if (this.preroll.length > 10) this.preroll.shift();
      this.above = rms > thr ? this.above + 1 : 0;
      if (this.above >= 3) {
        this.speaking = true;
        this.segment = [...this.preroll];
        this.voiced = this.above;
        this.silence = 0;
        this.onStart?.();
      } else if (this.mode === 'command') {
        this.waited += ms;
        if (this.waited > this.opts.noSpeechMs) {
          this.cancel();
          this.onTimeout?.();
        }
      }
      return;
    }

    this.segment.push(frame);
    if (rms > thr * 0.6) { this.silence = 0; this.voiced++; } else { this.silence += ms; }
    const length = this.segment.length * ms;
    if (this.silence >= this.opts.endSilenceMs || length >= this.opts.maxMs) this.close(false);
  }

  close(forced) {
    const ms = (FRAME / TARGET_RATE) * 1000;
    const enough = this.voiced * ms >= this.opts.minSpeechMs;
    const frames = this.segment;
    const mode = this.mode;
    if (mode === 'command') this.mode = null;
    this.reset();
    if (!enough) {
      if (mode === 'command') this.onTimeout?.();
      return;
    }
    const total = frames.reduce((n, f) => n + f.length, 0);
    const audio = new Float32Array(total);
    let off = 0;
    for (const f of frames) { audio.set(f, off); off += f.length; }
    this.onEnd?.(audio, { mode, forced });
  }
}

function impulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

/** Speech output through an EQ + chorus + slapback + small-hall chain for the synthetic AI timbre. */
export class VoiceOut {
  constructor() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.input = ctx.createGain();

    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 85 });
    const low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 190, gain: 2.5 });
    const presence = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2900, Q: 0.9, gain: 2.5 });
    const air = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 8500, gain: 3 });
    this.input.connect(hp).connect(low).connect(presence).connect(air);
    this.eqOut = air;

    this.comp = new DynamicsCompressorNode(ctx, { threshold: -20, knee: 12, ratio: 3.2, attack: 0.004, release: 0.18 });
    this.master = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.comp.connect(this.master).connect(this.analyser).connect(ctx.destination);

    const dry = ctx.createGain();
    air.connect(dry).connect(this.comp);

    // chorus: short modulated delay
    const chorus = new DelayNode(ctx, { delayTime: 0.012, maxDelayTime: 0.05 });
    const lfo = new OscillatorNode(ctx, { frequency: 0.33 });
    const depth = new GainNode(ctx, { gain: 0.0022 });
    lfo.connect(depth).connect(chorus.delayTime);
    lfo.start();
    this.chorusWet = new GainNode(ctx, { gain: 0.2 });
    air.connect(chorus).connect(this.chorusWet).connect(this.comp);

    // slapback with a little feedback — the "inside the suit" metallic room
    const slap = new DelayNode(ctx, { delayTime: 0.075, maxDelayTime: 0.3 });
    const fb = new GainNode(ctx, { gain: 0.16 });
    const slapTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3600 });
    this.slapWet = new GainNode(ctx, { gain: 0.1 });
    air.connect(slap).connect(slapTone).connect(this.slapWet).connect(this.comp);
    slapTone.connect(fb).connect(slap);

    const verb = new ConvolverNode(ctx, { buffer: impulse(ctx, 1.1, 3.4) });
    this.verbWet = new GainNode(ctx, { gain: 0.14 });
    air.connect(verb).connect(this.verbWet).connect(this.comp);

    this.current = null;
    this.setFx(true);
    this.setVolume(0.9);
  }

  setFx(on) {
    this.fx = on;
    const t = this.ctx.currentTime;
    this.chorusWet.gain.setTargetAtTime(on ? 0.2 : 0, t, 0.05);
    this.slapWet.gain.setTargetAtTime(on ? 0.1 : 0, t, 0.05);
    this.verbWet.gain.setTargetAtTime(on ? 0.14 : 0, t, 0.05);
  }

  setVolume(v) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async decode(bytes) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return this.ctx.decodeAudioData(ab);
  }

  /** raw: skip the EQ and "AI" effects — for recorded phrases that already carry their own sound. */
  play(buffer, raw = false) {
    this.stop();
    return new Promise((resolve) => {
      const src = new AudioBufferSourceNode(this.ctx, { buffer });
      src.connect(raw ? this.comp : this.input);
      src.onended = () => {
        if (this.current === src) this.current = null;
        resolve();
      };
      this.current = src;
      src.start();
    });
  }

  stop() {
    if (this.current) {
      const src = this.current;
      this.current = null;
      try { src.stop(); } catch { /* not started */ }
    }
  }

  // ---- interface sounds ----
  tone({ from, to, dur, type = 'sine', gain = 0.08, at = 0 }) {
    const t0 = this.ctx.currentTime + at;
    const osc = new OscillatorNode(this.ctx, { type, frequency: from });
    osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = new GainNode(this.ctx, { gain: 0 });
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.verbWet.gain.value > 0 ? this.input : this.comp);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  sfx(name) {
    switch (name) {
      case 'listen':
        this.tone({ from: 880, to: 1320, dur: 0.07, gain: 0.06 });
        this.tone({ from: 1320, to: 1760, dur: 0.08, gain: 0.05, at: 0.08 });
        break;
      case 'captured':
        this.tone({ from: 1400, to: 900, dur: 0.09, gain: 0.05 });
        break;
      case 'error':
        this.tone({ from: 220, to: 160, dur: 0.16, type: 'square', gain: 0.025 });
        this.tone({ from: 220, to: 150, dur: 0.18, type: 'square', gain: 0.025, at: 0.2 });
        break;
      case 'boot':
        this.tone({ from: 90, to: 900, dur: 1.2, type: 'sawtooth', gain: 0.018 });
        this.tone({ from: 180, to: 1800, dur: 1.3, gain: 0.03, at: 0.1 });
        this.tone({ from: 1760, to: 1760, dur: 0.35, gain: 0.03, at: 1.35 });
        break;
      case 'tick':
        this.tone({ from: 2400, to: 1800, dur: 0.03, gain: 0.025 });
        break;
      default:
        break;
    }
  }
}
