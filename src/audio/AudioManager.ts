// NECROFALL — tiny WebAudio synthesizer (no audio assets, everything generated).

import { IS_MOBILE } from '../core/Config';

export type SfxName =
  | 'shoot' | 'hit' | 'enemyHit' | 'enemyDeath' | 'kill' | 'jump' | 'dash' | 'land'
  | 'skill' | 'ult' | 'explode' | 'levelup' | 'pickup' | 'mutation' | 'super'
  | 'capture' | 'shieldDown' | 'beacon' | 'bossRoar' | 'bossDeath'
  | 'victory' | 'defeat' | 'respawn' | 'regen' | 'xp' | 'ui' | 'alarm';

interface VoiceOpts {
  freq: number;
  to?: number;
  dur: number;
  type?: OscillatorType;
  vol: number;
  delay?: number;
  attack?: number;
  detune?: number;
  /** Post-oscillator filter; `to` sweeps it over the voice's life. */
  filter?: { type?: BiquadFilterType; from: number; to?: number; q?: number };
  /** 0..1 amount of this voice sent to the reverb. */
  send?: number;
}

interface NoiseOpts {
  dur: number;
  vol: number;
  from: number;
  to?: number;
  q?: number;
  type?: BiquadFilterType;
  delay?: number;
  attack?: number;
  send?: number;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private send: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private lastPlay = new Map<string, number>();
  private volume = 0.3;
  enabled = true;
  /**
   * Live voices and the ceiling they may reach. Every sound is a handful of one-shot oscillator /
   * buffer nodes (the standard WebAudio pattern: a node cannot be restarted, so "reuse" means
   * gating repeats and capping the count, not pooling nodes). A multi-kill with three ults up must
   * not stack fifty of them on a phone speaker — the mix would only turn to mud anyway.
   */
  private voices = 0;
  private readonly maxVoices = IS_MOBILE ? 20 : 40;

  // Signal path:  voice -> dry ----------------------\
  //               voice -> send -> reverb ----------> master -> compressor -> out
  unlock(): void {
    if (!this.ctx) {
      const AC: typeof AudioContext =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;

      // compressor keeps stacked hits (multi-kills, ults) from crackling
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 22;
      comp.ratio.value = 3.5;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      const master = ctx.createGain();
      master.gain.value = this.enabled ? this.volume : 0;
      master.connect(comp).connect(ctx.destination);
      this.master = master;

      const dry = ctx.createGain();
      dry.gain.value = 1;
      dry.connect(master);
      this.dry = dry;

      // generated reverb tail — exponentially decaying stereo noise, nothing to download
      const conv = ctx.createConvolver();
      const len = Math.floor(ctx.sampleRate * 1.6);
      const imp = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = imp.getChannelData(ch);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      conv.buffer = imp;
      const send = ctx.createGain();
      send.gain.value = 1;
      send.connect(conv).connect(master);
      this.send = send;

      const nlen = Math.floor(ctx.sampleRate * 1.2);
      const buf = ctx.createBuffer(1, nlen, ctx.sampleRate);
      const nd = buf.getChannelData(0);
      for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (this.master) this.master.gain.value = v ? this.volume : 0;
    // A disabled mix must not keep the audio thread awake: suspend costs nothing and the graph is
    // exactly where it was when it comes back.
    if (v) this.resume();
    else this.suspend();
  }

  /** Stop / restart the audio thread (tab hidden, audio disabled). The graph state is preserved. */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.enabled && this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private ready(name: string, gap = 45): boolean {
    if (!this.enabled || !this.ctx || !this.master || this.ctx.state !== 'running') return false;
    const now = performance.now();
    if (now - (this.lastPlay.get(name) ?? 0) < gap) return false;
    this.lastPlay.set(name, now);
    return true;
  }

  /** One oscillator voice: pitch + amplitude envelope, optional filter sweep, optional reverb send. */
  private voice(o: VoiceOpts): void {
    if (this.voices >= this.maxVoices) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const dur = Math.max(0.02, o.dur);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(20, o.freq), t0);
    if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + dur);
    if (o.detune) osc.detune.value = o.detune;

    const g = ctx.createGain();
    const atk = Math.min(o.attack ?? Math.min(0.014, dur * 0.25), dur * 0.6);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.vol, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let node: AudioNode = osc;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filter.type ?? 'lowpass';
      f.frequency.setValueAtTime(Math.max(40, o.filter.from), t0);
      if (o.filter.to !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.filter.to), t0 + dur);
      f.Q.value = o.filter.q ?? 0.8;
      osc.connect(f);
      node = f;
    }
    node.connect(g).connect(this.dry!);
    if (o.send) {
      const s = ctx.createGain();
      s.gain.value = o.send;
      g.connect(s).connect(this.send!);
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
    this.voices++;
    osc.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
    };
  }

  /** Filtered noise burst — the texture layer for impacts, whooshes and explosions. */
  private noiseHit(o: NoiseOpts): void {
    if (this.voices >= this.maxVoices) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const dur = Math.max(0.015, o.dur);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'lowpass';
    f.frequency.setValueAtTime(Math.max(40, o.from), t0);
    if (o.to !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.to), t0 + dur);
    f.Q.value = o.q ?? 0.9;
    const g = ctx.createGain();
    const atk = Math.min(o.attack ?? 0.005, dur * 0.5);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.vol, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.dry!);
    if (o.send) {
      const s = ctx.createGain();
      s.gain.value = o.send;
      g.connect(s).connect(this.send!);
    }
    src.start(t0);
    src.stop(t0 + dur + 0.03);
    this.voices++;
    src.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
    };
  }

  /** Small pitch randomiser so repeated shots never sound mechanical. */
  private jitter(amount: number): number {
    return 1 + (Math.random() * 2 - 1) * amount;
  }

  sfx(name: SfxName, vol = 1): void {
    // repeated sounds (auto-attack, hits) need a tighter gate so bursts stay legible
    const gap = name === 'shoot' ? 26 : name === 'hit' || name === 'enemyHit' ? 22 : 45;
    if (!this.ready(name, gap)) return;
    const v = vol;
    switch (name) {
      // ---- weapon: a punchy, layered "pew" — snap transient, bright body that drops in pitch,
      // and a real low thump under it. Slight detune per shot keeps sustained fire organic.
      case 'shoot': {
        const f = 840 * this.jitter(0.045);
        // 1) snap: a very short bright click so each shot has attack
        this.noiseHit({ dur: 0.01, vol: 0.05 * v, from: 6500, to: 2600, type: 'highpass', q: 0.6 });
        // 2) body: the pitched drop that makes it read as a shot
        this.voice({ freq: f, to: 210, dur: 0.11, type: 'triangle', vol: 0.075 * v, filter: { from: 3200, to: 800, q: 1.3 }, send: 0.12 });
        this.voice({ freq: f * 1.5, to: 320, dur: 0.07, type: 'sine', vol: 0.03 * v, delay: 0.004 });
        // 3) thump: the satisfying weight under the crack
        this.voice({ freq: 190, to: 62, dur: 0.13, type: 'sine', vol: 0.07 * v, attack: 0.003 });
        // 4) tail: a whisper of air so bursts don't sound clipped
        this.noiseHit({ dur: 0.09, vol: 0.022 * v, from: 1800, to: 500, q: 0.8, send: 0.18 });
        break;
      }
      // ---- dash: an instant, weighty burst of air — punch in, sweep up, thump out
      case 'dash': {
        // the "punch": a hard, short burst right at the start
        this.noiseHit({ dur: 0.05, vol: 0.11 * v, from: 900, to: 400, q: 1.2, type: 'lowpass', attack: 0.002 });
        this.voice({ freq: 150, to: 55, dur: 0.16, type: 'sine', vol: 0.12 * v, attack: 0.003 });
        // the whoosh: band-passed noise that sweeps up and fades, with a rising tail layer
        this.noiseHit({ dur: 0.32, vol: 0.13 * v, from: 500, to: 3400, q: 1.7, type: 'bandpass', attack: 0.012, send: 0.32 });
        this.voice({ freq: 320, to: 900, dur: 0.24, type: 'sine', vol: 0.03 * v, delay: 0.02, send: 0.3 });
        // the flick: a bright, fast "shhk" riding on top
        this.noiseHit({ dur: 0.13, vol: 0.05 * v, from: 2800, to: 6200, q: 1.1, type: 'highpass', delay: 0.015, send: 0.4 });
        break;
      }
      // ---- impacts: dark thud + click so combat never turns shrill
      case 'hit':
      case 'enemyHit': {
        this.noiseHit({ dur: 0.09, vol: 0.09 * v, from: 1700, to: 500, q: 1.1 });
        this.voice({ freq: 200 * this.jitter(0.08), to: 78, dur: 0.1, type: 'sine', vol: 0.06 * v });
        break;
      }
      case 'enemyDeath': {
        this.noiseHit({ dur: 0.3, vol: 0.12 * v, from: 1200, to: 260, q: 1.2, send: 0.22 });
        this.voice({ freq: 190, to: 48, dur: 0.34, type: 'sawtooth', vol: 0.05 * v, filter: { from: 700, to: 180 } });
        break;
      }
      case 'kill': {
        [784, 1175].forEach((f, i) => this.voice({ freq: f, dur: 0.2, type: 'triangle', vol: 0.05 * v, delay: i * 0.07, send: 0.35 }));
        this.noiseHit({ dur: 0.2, vol: 0.03 * v, from: 3000, to: 1400, type: 'highpass', send: 0.3 });
        break;
      }
      // ---- jump: a springy lift — soft launch, rising body, tiny air puff
      case 'jump': {
        this.voice({ freq: 260, to: 720, dur: 0.2, type: 'sine', vol: 0.09 * v, attack: 0.016, send: 0.18 });
        this.voice({ freq: 520, to: 1180, dur: 0.13, type: 'triangle', vol: 0.028 * v, delay: 0.01, send: 0.22 });
        this.noiseHit({ dur: 0.11, vol: 0.032 * v, from: 1200, to: 3000, type: 'bandpass', q: 1.2, attack: 0.008 });
        break;
      }
      // ---- landing: soft but solid — the low thud plus a shuffle of grit
      case 'land': {
        this.noiseHit({ dur: 0.13, vol: 0.1 * v, from: 800, to: 240, q: 1.1, attack: 0.003 });
        this.voice({ freq: 120, to: 52, dur: 0.16, type: 'sine', vol: 0.08 * v, attack: 0.003 });
        break;
      }
      case 'skill': {
        this.voice({ freq: 330, to: 990, dur: 0.26, type: 'triangle', vol: 0.06 * v, attack: 0.012, filter: { from: 700, to: 3200, q: 1.2 }, send: 0.3 });
        this.voice({ freq: 495, to: 1485, dur: 0.24, type: 'sine', vol: 0.03 * v, delay: 0.015 });
        this.noiseHit({ dur: 0.2, vol: 0.045 * v, from: 1200, to: 3600, type: 'bandpass', q: 1.1, send: 0.35 });
        break;
      }
      case 'ult': {
        // a wide chord, a sub drop and a long shimmer — this should feel like an event
        [110, 165, 220, 330].forEach((f, i) =>
          this.voice({ freq: f, to: f * 1.5, dur: 1.1, type: i === 0 ? 'sawtooth' : 'triangle', vol: (i === 0 ? 0.07 : 0.04) * v, delay: i * 0.02, filter: { from: 500, to: 2400, q: 1.2 }, send: 0.5 })
        );
        this.voice({ freq: 70, to: 38, dur: 0.9, type: 'sine', vol: 0.09 * v });
        this.noiseHit({ dur: 1.0, vol: 0.06 * v, from: 600, to: 4200, type: 'bandpass', q: 1.1, send: 0.55 });
        break;
      }
      case 'explode': {
        this.noiseHit({ dur: 0.6, vol: 0.2 * v, from: 1400, to: 180, q: 0.9, send: 0.35 });
        this.noiseHit({ dur: 0.16, vol: 0.1 * v, from: 5200, to: 1600, type: 'highpass', q: 0.7 });
        this.voice({ freq: 95, to: 32, dur: 0.6, type: 'sine', vol: 0.14 * v });
        break;
      }
      case 'levelup': {
        [523, 659, 784, 1046].forEach((f, i) =>
          this.voice({ freq: f, dur: 0.32, type: 'triangle', vol: 0.05 * v, delay: i * 0.08, send: 0.45, attack: 0.01 })
        );
        break;
      }
      case 'pickup': {
        this.voice({ freq: 1046, dur: 0.2, type: 'sine', vol: 0.06 * v, send: 0.4, attack: 0.006 });
        this.voice({ freq: 1568, dur: 0.26, type: 'sine', vol: 0.04 * v, delay: 0.06, send: 0.5 });
        break;
      }
      case 'mutation': {
        this.voice({ freq: 150, to: 700, dur: 0.6, type: 'sawtooth', vol: 0.06 * v, filter: { from: 400, to: 2600, q: 2 }, send: 0.4 });
        this.voice({ freq: 600, to: 170, dur: 0.6, type: 'triangle', vol: 0.04 * v, delay: 0.05, send: 0.4 });
        break;
      }
      case 'super': {
        [80, 160, 240, 480, 960].forEach((f, i) =>
          this.voice({ freq: f, to: f * 1.5, dur: 0.75, type: 'sawtooth', vol: 0.05 * v, delay: i * 0.05, filter: { from: 300, to: 2600, q: 1.6 }, send: 0.55 })
        );
        this.noiseHit({ dur: 1.1, vol: 0.09 * v, from: 800, to: 5200, type: 'bandpass', q: 1.2, send: 0.6 });
        break;
      }
      case 'capture': {
        [392, 523, 659].forEach((f, i) => this.voice({ freq: f, dur: 0.4, type: 'triangle', vol: 0.06 * v, delay: i * 0.14, send: 0.4 }));
        break;
      }
      case 'shieldDown': {
        this.voice({ freq: 900, to: 110, dur: 0.6, type: 'sawtooth', vol: 0.07 * v, filter: { from: 2200, to: 300, q: 1.4 }, send: 0.4 });
        this.noiseHit({ dur: 0.5, vol: 0.09 * v, from: 2600, to: 400, type: 'bandpass', q: 1, send: 0.3 });
        break;
      }
      case 'beacon': {
        [220, 330, 440].forEach((f, i) => this.voice({ freq: f, to: f * 2, dur: 0.7, type: 'triangle', vol: 0.055 * v, delay: i * 0.09, send: 0.5 }));
        break;
      }
      case 'bossRoar': {
        this.voice({ freq: 66, to: 42, dur: 1.1, type: 'sawtooth', vol: 0.12 * v, filter: { from: 320, to: 160, q: 1.4 }, send: 0.45 });
        this.voice({ freq: 99, to: 61, dur: 1.0, type: 'square', vol: 0.035 * v, delay: 0.04, filter: { from: 500, to: 220 } });
        this.noiseHit({ dur: 0.9, vol: 0.09 * v, from: 700, to: 220, q: 1.1, send: 0.3 });
        break;
      }
      case 'bossDeath': {
        this.voice({ freq: 130, to: 26, dur: 1.4, type: 'sawtooth', vol: 0.12 * v, filter: { from: 600, to: 120, q: 1.2 }, send: 0.5 });
        this.noiseHit({ dur: 1.3, vol: 0.15 * v, from: 1400, to: 160, q: 0.9, send: 0.45 });
        break;
      }
      case 'victory': {
        [523, 659, 784, 1046, 1318].forEach((f, i) =>
          this.voice({ freq: f, dur: 0.6, type: 'triangle', vol: 0.06 * v, delay: i * 0.13, send: 0.5, attack: 0.012 })
        );
        break;
      }
      case 'defeat': {
        [440, 370, 294, 220].forEach((f, i) =>
          this.voice({ freq: f, to: f * 0.94, dur: 0.7, type: 'sawtooth', vol: 0.055 * v, delay: i * 0.2, filter: { from: 900, to: 380, q: 1.1 }, send: 0.4 })
        );
        break;
      }
      case 'respawn': {
        this.voice({ freq: 190, to: 760, dur: 0.4, type: 'sine', vol: 0.07 * v, attack: 0.03, send: 0.35 });
        break;
      }
      case 'regen': {
        this.voice({ freq: 880, to: 1320, dur: 0.22, type: 'sine', vol: 0.028 * v, send: 0.4, attack: 0.02 });
        break;
      }
      case 'xp': {
        this.voice({ freq: 1180 * this.jitter(0.03), to: 1620, dur: 0.08, type: 'sine', vol: 0.028 * v, send: 0.25 });
        break;
      }
      case 'ui': {
        this.noiseHit({ dur: 0.03, vol: 0.03 * v, from: 3200, to: 1800, type: 'highpass' });
        this.voice({ freq: 880, dur: 0.05, type: 'triangle', vol: 0.03 * v });
        break;
      }
      case 'alarm': {
        [660, 520].forEach((f, i) =>
          this.voice({ freq: f, dur: 0.32, type: 'square', vol: 0.05 * v, delay: i * 0.16, filter: { from: 1800, to: 1200 }, send: 0.3 })
        );
        break;
      }
    }
  }
}
