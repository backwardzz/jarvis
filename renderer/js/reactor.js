// Arc-reactor style HUD core drawn on a canvas; reacts to state and to live audio.
const COLORS = {
  idle: [67, 229, 255],
  wake: [67, 229, 255],
  listening: [140, 245, 255],
  transcribing: [120, 220, 255],
  thinking: [255, 181, 71],
  speaking: [80, 235, 255],
  error: [255, 77, 94],
};
const TAU = Math.PI * 2;
const BARS = 64; // per half, mirrored

export class Reactor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'idle';
    this.color = [...COLORS.idle];
    this.analyser = null;
    this.freq = null;
    this.wave = null;
    this.spectrum = new Float32Array(BARS);
    this.level = 0;
    this.speed = 1;
    this.ripples = [];
    this.lastRipple = 0;
    this.last = performance.now();
    this.t = 0;
    this.labels = ['SYS.ONLINE', 'CORE 03', 'VOX.MOD', 'NET.LINK', 'AUX 7F', 'HUD.MK-VII'];
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setState(state) {
    this.state = state;
  }

  setAnalyser(analyser) {
    this.analyser = analyser;
    if (analyser) {
      this.freq = new Uint8Array(analyser.frequencyBinCount);
      this.wave = new Uint8Array(analyser.fftSize);
    }
  }

  rgba(a, mix = 0) {
    const [r, g, b] = this.color;
    const m = (v) => Math.round(v + (255 - v) * mix);
    return `rgba(${m(r)},${m(g)},${m(b)},${a})`;
  }

  sample(dt) {
    let level = 0;
    const live = this.analyser && ['listening', 'speaking', 'wake'].includes(this.state);
    if (live) {
      this.analyser.getByteFrequencyData(this.freq);
      this.analyser.getByteTimeDomainData(this.wave);
      let sum = 0;
      for (let i = 0; i < this.wave.length; i++) { const v = (this.wave[i] - 128) / 128; sum += v * v; }
      level = Math.min(1, Math.sqrt(sum / this.wave.length) * 4.2);
      const bins = Math.floor(this.freq.length * 0.55);
      for (let i = 0; i < BARS; i++) {
        const idx = 2 + Math.floor((i / BARS) * (bins - 2));
        const v = this.freq[idx] / 255;
        this.spectrum[i] = Math.max(v * v * 1.25, this.spectrum[i] * Math.pow(0.02, dt));
      }
    } else {
      for (let i = 0; i < BARS; i++) {
        const idle = 0.05 + 0.035 * Math.sin(this.t * 1.6 + i * 0.35) + 0.02 * Math.sin(this.t * 3.1 - i * 0.9);
        const think = this.state === 'thinking' ? 0.1 * Math.max(0, Math.sin(this.t * 6 - i * 0.5)) : 0;
        this.spectrum[i] += (idle + think - this.spectrum[i]) * Math.min(1, dt * 6);
      }
    }
    this.level += (level - this.level) * Math.min(1, dt * 12);
  }

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    const target = COLORS[this.state] || COLORS.idle;
    for (let i = 0; i < 3; i++) this.color[i] += (target[i] - this.color[i]) * Math.min(1, dt * 4);
    const wantSpeed = this.state === 'thinking' ? 3.2 : this.state === 'transcribing' ? 2.2 : this.state === 'listening' ? 1.5 : 1;
    this.speed += (wantSpeed - this.speed) * Math.min(1, dt * 3);
    this.sample(dt);
    this.draw(now);
    requestAnimationFrame((t) => this.frame(t));
  }

  arc(r, a0, a1, width, style) {
    const c = this.ctx;
    c.beginPath();
    c.arc(this.cx, this.cy, r, a0, a1);
    c.lineWidth = width;
    c.strokeStyle = style;
    c.stroke();
  }

  draw(now) {
    const c = this.ctx;
    const R = Math.min(this.w, this.h) / 2 * 0.97;
    this.cx = this.w / 2;
    this.cy = this.h / 2;
    const { cx, cy, t } = this;
    const s = this.speed;
    this.rot = (this.rot || 0) + 0.016 * s;
    const rot = this.rot;
    c.clearRect(0, 0, this.w, this.h);
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'butt';

    // 1. outer tick ring
    c.save();
    c.translate(cx, cy);
    c.rotate(rot * 0.12);
    for (let i = 0; i < 180; i++) {
      const long = i % 15 === 0;
      const a = (i / 180) * TAU;
      const r1 = R * 0.995, r0 = r1 - R * (long ? 0.045 : 0.017);
      c.beginPath();
      c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      c.lineWidth = long ? 1.6 : 1;
      c.strokeStyle = this.rgba(long ? 0.65 : 0.28);
      c.stroke();
    }
    c.restore();

    // 2. thin ring with bright travelling segments
    this.arc(R * 0.935, 0, TAU, 1, this.rgba(0.22));
    for (let k = 0; k < 4; k++) {
      const a = -rot * 0.35 + (k * TAU) / 4;
      this.arc(R * 0.935, a, a + 0.32, 2.5, this.rgba(0.85));
    }

    // 3. heavy segmented ring
    for (let k = 0; k < 3; k++) {
      const a = rot * 0.9 + (k * TAU) / 3;
      this.arc(R * 0.875, a, a + 1.2, R * 0.022, this.rgba(0.42));
      this.arc(R * 0.875, a + 1.28, a + 1.36, R * 0.022, this.rgba(0.75));
    }
    this.arc(R * 0.845, 0, TAU, 1, this.rgba(0.18));

    // 4. rotating HUD labels
    c.save();
    c.translate(cx, cy);
    c.font = `${Math.max(8, R * 0.026)}px "JetBrains Mono", monospace`;
    c.fillStyle = this.rgba(0.55);
    c.textAlign = 'center';
    this.labels.forEach((label, i) => {
      const a = -rot * 0.18 + (i * TAU) / this.labels.length;
      c.save();
      c.rotate(a);
      c.translate(0, -R * 0.795);
      c.fillText(label, 0, 0);
      c.restore();
    });
    c.restore();

    // 5. thinking orbiters
    if (this.state === 'thinking' || this.state === 'transcribing') {
      const f = this.state === 'thinking' ? 1 : 0.6;
      const a = t * 4.2;
      this.arc(R * 0.74, a, a + 0.9, 3, this.rgba(0.9 * f));
      this.arc(R * 0.74, a + Math.PI, a + Math.PI + 0.9, 3, this.rgba(0.9 * f));
      this.arc(R * 0.705, -a * 1.3, -a * 1.3 + 0.5, 2, this.rgba(0.7 * f));
    }

    // 6. audio spectrum ring (mirrored)
    const base = R * 0.6;
    c.save();
    c.translate(cx, cy);
    c.rotate(-Math.PI / 2);
    const total = BARS * 2;
    for (let i = 0; i < total; i++) {
      const v = this.spectrum[i < BARS ? i : total - 1 - i];
      const a = (i / total) * TAU;
      const len = R * (0.012 + v * 0.2);
      c.beginPath();
      c.moveTo(Math.cos(a) * base, Math.sin(a) * base);
      c.lineTo(Math.cos(a) * (base + len), Math.sin(a) * (base + len));
      c.lineWidth = Math.max(1.4, (TAU * base) / total * 0.5);
      c.strokeStyle = this.rgba(0.35 + v * 0.65, v * 0.35);
      c.stroke();
    }
    c.restore();

    // 7. dashed ring + markers
    c.save();
    c.setLineDash([2, 7]);
    c.lineDashOffset = -rot * 20;
    this.arc(R * 0.565, 0, TAU, 2, this.rgba(0.5));
    c.restore();
    c.save();
    c.translate(cx, cy);
    c.rotate(-rot * 0.5);
    for (let k = 0; k < 4; k++) {
      c.rotate(TAU / 4);
      c.beginPath();
      c.moveTo(0, -R * 0.54);
      c.lineTo(-R * 0.018, -R * 0.505);
      c.lineTo(R * 0.018, -R * 0.505);
      c.closePath();
      c.fillStyle = this.rgba(0.8);
      c.fill();
    }
    c.restore();
    this.arc(R * 0.5, 0, TAU, 1, this.rgba(0.3));

    // 8. listening ripples
    if (this.state === 'listening' && now - this.lastRipple > 650) {
      this.ripples.push({ born: now });
      this.lastRipple = now;
    }
    this.ripples = this.ripples.filter((rp) => now - rp.born < 1600);
    for (const rp of this.ripples) {
      const k = (now - rp.born) / 1600;
      this.arc(R * (0.46 + k * 0.52), 0, TAU, 1.5, this.rgba(0.5 * (1 - k)));
    }

    // 9. reactor coils
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
    const lvl = this.level;
    c.save();
    c.translate(cx, cy);
    c.rotate(rot * 0.25);
    for (let k = 0; k < 10; k++) {
      const a0 = (k / 10) * TAU + 0.05;
      const a1 = a0 + TAU / 10 - 0.1;
      c.beginPath();
      c.arc(0, 0, R * 0.44, a0, a1);
      c.arc(0, 0, R * 0.36, a1 - 0.02, a0 + 0.02, true);
      c.closePath();
      c.fillStyle = this.rgba(0.12 + lvl * 0.35 + pulse * 0.05);
      c.fill();
      c.lineWidth = 1;
      c.strokeStyle = this.rgba(0.55 + lvl * 0.4);
      c.stroke();
    }
    c.restore();

    // 10. glowing core
    const coreR = R * (0.34 + lvl * 0.04);
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    g.addColorStop(0, this.rgba(0.55 + lvl * 0.35, 0.7));
    g.addColorStop(0.35, this.rgba(0.22 + lvl * 0.3, 0.2));
    g.addColorStop(1, this.rgba(0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, coreR, 0, TAU);
    c.fill();
    c.shadowBlur = 18 + lvl * 30;
    c.shadowColor = this.rgba(0.9);
    this.arc(R * 0.33, 0, TAU, 2 + lvl * 3, this.rgba(0.75 + lvl * 0.25, 0.3));
    c.shadowBlur = 0;
    this.arc(R * 0.3, 0, TAU, 1, this.rgba(0.35));

    // 11. outer halo
    const halo = c.createRadialGradient(cx, cy, R * 0.3, cx, cy, R);
    halo.addColorStop(0, this.rgba(0.08 + lvl * 0.1));
    halo.addColorStop(1, this.rgba(0));
    c.fillStyle = halo;
    c.beginPath();
    c.arc(cx, cy, R, 0, TAU);
    c.fill();

    c.restore();
  }
}
