// Audio-Engine: WebAudio für prozedurale Fallback-SFX plus kuratierte Pixabay-Musik/Samples.
// Lazy-Init beim ersten Nutzer-Gesture (Browser-Autoplay-Richtlinie).
import { MUSIC_PLAYLISTS, SFX_SAMPLES } from './audioManifest.js';

const MUSIC_GAIN = { calm: 0.16, combat: 0.24 };
const MUSIC_CROSSFADE = 5.5;
const COMBAT_HOLD = 12;

// Persistente Ton-Einstellungen (überleben Reload). '1' = an, '0' = aus; fehlend = Standard (an).
function loadAudioPref(key, def = true) {
  try { const v = localStorage.getItem(key); return v == null ? def : v === '1'; } catch { return def; }
}
function saveAudioPref(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch {}
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;       // wiederverwendeter Rauschpuffer
    // Getrennt schaltbar: Musik und Soundeffekte (inkl. Regen-Ambiente). Per Menü umschaltbar.
    this.musicMuted = !loadAudioPref('if_music_on', true);
    this.sfxMuted = !loadAudioPref('if_sfx_on', true);
    this.frameBudget = {};   // pro Frame gedrosselte Soundzahl je Kategorie
    this.music = [];
    this.musicMode = null;
    this.musicDeck = 0;
    this.musicIndex = { calm: 0, combat: 0 };
    this.lastCombatAt = -999;
    this.sampleCache = new Map();
    this.beat = 0;
  }

  // Beim ersten Klick/Tastendruck aufrufen (entsperrt den AudioContext).
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.sfxMuted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      // 1 s weißes Rauschen als Quelle für Schüsse/Explosionen.
      const len = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this._ensureMusic();
  }

  get musicEnabled() { return !this.musicMuted; }
  get sfxEnabled() { return !this.sfxMuted; }

  // Musik separat schalten (Hintergrundmusik-Decks).
  setMusicEnabled(on) {
    this.musicMuted = !on;
    saveAudioPref('if_music_on', on);
    for (const deck of this.music) if (deck.el) deck.el.volume = this.musicMuted ? 0 : deck.gain;
  }

  // Soundeffekte separat schalten — Master-Gain deckt alle Synth-SFX UND das Regen-Ambiente ab,
  // die per-Sample gespielten Clips greifen zusätzlich auf this.sfxMuted zurück.
  setSfxEnabled(on) {
    this.sfxMuted = !on;
    saveAudioPref('if_sfx_on', on);
    if (this.master) this.master.gain.value = this.sfxMuted ? 0 : 0.5;
  }

  // Kompatibilität: alles gemeinsam stummschalten.
  setMuted(m) { this.setMusicEnabled(!m); this.setSfxEnabled(!m); }
  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  // Drossel: maximal n Sounds einer Kategorie pro Frame (Großschlachten überfluten den Mixer nicht).
  beginFrame() { this.frameBudget = {}; }
  _budget(cat, n) {
    const c = (this.frameBudget[cat] || 0);
    if (c >= n) return false;
    this.frameBudget[cat] = c + 1; return true;
  }

  _noiseSource() { const s = this.ctx.createBufferSource(); s.buffer = this.noise; return s; }
  _env(g, t0, peak, dur, attack = 0.005) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  // Gefilterter Rauschstoß (Schüsse). type: lowpass/highpass, freq, dur.
  _burst(vol, freq, dur, q = 1, type = 'lowpass') {
    const t0 = this.ctx.currentTime;
    const src = this._noiseSource();
    const filt = this.ctx.createBiquadFilter();
    filt.type = type; filt.frequency.value = freq; filt.Q.value = q;
    const g = this.ctx.createGain();
    this._env(g, t0, vol, dur);
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  // Tiefer Sinus-Schlag (Kanonen/Explosionen) mit Tonhöhenabfall.
  _thump(vol, f0, f1, dur) {
    const t0 = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = this.ctx.createGain();
    this._env(g, t0, vol, dur, 0.004);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  // Kurzer Ton (Glocke/Chime) für UI-Feedback.
  _tone(vol, freq, dur, type = 'triangle', delay = 0) {
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const g = this.ctx.createGain();
    this._env(g, t0, vol, dur, 0.01);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  _ensureMusic() {
    if (this.music.length || typeof window === 'undefined') return;
    for (let i = 0; i < 2; i++) {
      const el = document.createElement('audio');
      el.preload = 'auto'; el.loop = false;
      this.music.push({ el, gain: 0, target: 0, mode: null, fade: MUSIC_CROSSFADE });
    }
    this._startMusic('calm', 1.5);
  }

  _startMusic(mode, fade = MUSIC_CROSSFADE) {
    const list = MUSIC_PLAYLISTS[mode] || MUSIC_PLAYLISTS.calm;
    if (!list.length) return;
    const deck = this.music[this.musicDeck];
    const track = list[this.musicIndex[mode] % list.length];
    this.musicIndex[mode] = (this.musicIndex[mode] + 1) % list.length;
    deck.el.src = track.src;
    deck.el.volume = 0;
    deck.el.currentTime = 0;
    deck.mode = mode;
    deck.fade = fade;
    deck.target = MUSIC_GAIN[mode] || 0.16;
    deck.el.play().catch(() => {});
    for (let i = 0; i < this.music.length; i++) if (i !== this.musicDeck) {
      this.music[i].target = 0;
      this.music[i].fade = fade;
    }
    this.musicMode = mode;
    this.musicDeck = (this.musicDeck + 1) % this.music.length;
  }

  updateMusic(dt, env = null) {
    if (!this.ready || !this.music.length) return;
    const t = this.ctx.currentTime;
    const desired = t - this.lastCombatAt < COMBAT_HOLD ? 'combat' : 'calm';
    if (desired !== this.musicMode) this._startMusic(desired, MUSIC_CROSSFADE);
    for (const deck of this.music) {
      const alpha = Math.min(1, dt / Math.max(0.1, deck.fade || MUSIC_CROSSFADE));
      deck.gain += (deck.target - deck.gain) * alpha;
      deck.el.volume = this.musicMuted ? 0 : deck.gain;
      if (deck.target > 0 && deck.el.duration && Number.isFinite(deck.el.duration)
        && deck.el.duration - deck.el.currentTime < MUSIC_CROSSFADE + 0.5) {
        this._startMusic(deck.mode || desired, MUSIC_CROSSFADE);
      }
    }
    const night = env ? Math.max(0, 1 - (env.d ?? 1)) : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * (desired === 'combat' ? 6.5 : 2.4));
    this.beat = night * (0.25 + pulse * (desired === 'combat' ? 0.75 : 0.45));
  }

  markCombat() {
    if (this.ready) this.lastCombatAt = this.ctx.currentTime;
  }

  musicBeat() { return this.beat || 0; }

  _sample(cat, vol = 1, rate = 1) {
    if (!this.ready || this.sfxMuted || vol <= 0.02) return false;
    const list = SFX_SAMPLES[cat];
    if (!list || !list.length) return false;
    const src = list[(Math.random() * list.length) | 0];
    let base = this.sampleCache.get(src);
    if (!base) {
      base = document.createElement('audio');
      base.src = src; base.preload = 'auto';
      this.sampleCache.set(src, base);
    }
    const el = base.cloneNode();
    el.volume = Math.max(0, Math.min(1, vol));
    el.playbackRate = Math.max(0.65, Math.min(1.35, rate));
    el.play().catch(() => {});
    return true;
  }

  // --- Spiel-Sounds ---
  fire(weapon, vol = 1) {
    if (!this.ready || this.sfxMuted || vol <= 0.02) return;
    if (!this._budget('fire', 6)) return;
    this.markCombat();
    const v = 0.35 * vol;
    switch (weapon) {
      case 'tank_cannon': case 'turret_cannon': case 'naval_gun': case 'artillery':
        this._sample('artillery', Math.min(0.32, v * 0.7), 0.92 + Math.random() * 0.12);
        this._thump(v, 220, 60, 0.22); this._burst(v * 0.5, 900, 0.12, 0.7); break;
      case 'sam_missile': case 'aa_missile': case 'at_launcher': case 'torpedo': case 'micro_missile':
        this._burst(v * 0.6, 1800, 0.3, 0.4, 'bandpass'); this._thump(v * 0.3, 400, 120, 0.18); break;
      case 'rocket_salvo':
        this._burst(v * 0.8, 1300, 0.34, 0.45, 'bandpass'); this._thump(v * 0.45, 300, 70, 0.22); break;
      case 'bomb':
        this._thump(v * 1.2, 160, 45, 0.4); break;
      case 'flak_gun': case 'turret_flak': case 'turret_mg': case 'autocannon': case 'chain_gun':
        this._sample('gunfire', Math.min(0.22, v * 0.5), 0.95 + Math.random() * 0.1);
        this._burst(v * 0.7, 2200, 0.06, 1.5); break;
      default: // rifle
        this._sample('shoot', Math.min(0.18, v * 0.65), 0.9 + Math.random() * 0.2);
        this._burst(v, 3000, 0.05, 1.2, 'highpass');
    }
  }

  explosion(scale = 1, vol = 1) {
    if (!this.ready || this.sfxMuted || vol <= 0.02) return;
    if (!this._budget('explosion', 8)) return;
    this.markCombat();
    const v = Math.min(0.9, 0.4 * vol * (0.7 + scale * 0.2));
    this._sample('explosion', Math.min(0.45, v * 0.8), 0.85 + Math.random() * 0.14);
    this._thump(v, 120 + 40 / scale, 30, 0.35 + scale * 0.12);
    this._burst(v * 0.8, 700, 0.25 + scale * 0.08, 0.6);
  }

  // Donnerschlag: Knall (Hochpass-Crack) + langes tiefes Grollen.
  thunder(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('thunder', 2)) return;
    this._burst(0.5 * vol, 2500, 0.08, 0.8, 'highpass');
    this._burst(0.6 * vol, 140, 1.6, 0.4);
    this._thump(0.5 * vol, 90, 28, 1.2);
  }

  // Infanterie-Marschbefehl: zwei kurze, weiche Schritt-Taps (kein Maschinensound für Menschen).
  steps(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('steps', 2)) return;
    this._burst(0.10 * vol, 900, 0.05, 0.8);
    setTimeout(() => { if (this.ready && !this.sfxMuted) this._burst(0.08 * vol, 750, 0.05, 0.8); }, 120);
  }

  // Steinschlag: kurzes, trockenes Poltern.
  rocks(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('rocks', 2)) return;
    this._burst(0.25 * vol, 300, 0.18, 0.6);
    this._thump(0.15 * vol, 110, 50, 0.15);
  }

  // Erdbeben: langes, sehr tiefes Grollen.
  rumble() {
    if (!this.ready || this.sfxMuted) return;
    this._burst(0.55, 70, 3.2, 0.3);
    this._thump(0.4, 50, 22, 2.8);
  }

  command(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('command', 3)) return;
    if (!this._sample('yes', 0.18 * vol, 0.94 + Math.random() * 0.08)) this._tone(0.18 * vol, 520, 0.08);
  }

  motor(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('motor', 2)) return;
    if (!this._sample('motor', 0.16 * vol, 0.9 + Math.random() * 0.12)) this._burst(0.08 * vol, 180, 0.16, 0.4);
  }

  excavate(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('excavator', 2)) return;
    if (!this._sample('excavator', 0.22 * vol, 0.9 + Math.random() * 0.1)) this._burst(0.18 * vol, 380, 0.16, 0.6);
  }

  // Dauerregen als gefilterte Rauschschleife; Lautstärke folgt der Wetterlage.
  setWeather(w) {
    if (!this.ready) return;
    if (!this._rain) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise; src.loop = true;
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'lowpass'; filt.frequency.value = 900;
      const g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(filt); filt.connect(g); g.connect(this.master);
      src.start();
      this._rain = g;
    }
    const target = this.sfxMuted ? 0 : w === 'storm' ? 0.10 : w === 'rain' ? 0.055 : 0;
    const t = this.ctx.currentTime;
    this._rain.gain.cancelScheduledValues(t);
    this._rain.gain.linearRampToValueAtTime(target, t + 1.5);
  }

  build(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    this._sample('construction', 0.18 * vol, 0.95 + Math.random() * 0.08);
    this._tone(0.25 * vol, 330, 0.12); this._tone(0.25 * vol, 495, 0.16, 'triangle', 0.1);
  }
  ready_(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('ready', 3)) return;
    this._sample('yes', 0.16 * vol, 1);
    this._tone(0.22 * vol, 660, 0.1); this._tone(0.22 * vol, 880, 0.12, 'triangle', 0.08);
  }
  defeat() { if (!this.ready || this.sfxMuted) return; this._tone(0.4, 330, 0.5, 'sawtooth'); this._tone(0.4, 220, 0.7, 'sawtooth', 0.25); }
}
