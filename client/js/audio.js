// Audio-Engine: WebAudio für prozedurale Fallback-SFX plus kuratierte Pixabay-Musik/Samples.
// Lazy-Init beim ersten Nutzer-Gesture (Browser-Autoplay-Richtlinie).
import { MUSIC_PLAYLISTS, SFX_SAMPLES, COMMAND_VOICE_SAMPLES } from './audioManifest.js';

const MUSIC_GAIN = { calm: 0.13, combat: 0.26 }; // ruhiger im Aufbau, deutlich wilder im Gefecht
const MUSIC_CROSSFADE = 5.5;
const COMBAT_HOLD = 12;
const MOVE_VOICE_COOLDOWN = 3.2;
const MOTOR_COOLDOWN = 1.6;

// Persistente Ton-Einstellungen (überleben Reload). '1' = an, '0' = aus; fehlend = Standard (an).
function loadAudioPref(key, def = true) {
  if (typeof window === 'undefined' || !window.localStorage) return def;
  try { const v = window.localStorage.getItem(key); return v == null ? def : v === '1'; } catch { return def; }
}
function saveAudioPref(key, on) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try { window.localStorage.setItem(key, on ? '1' : '0'); } catch {}
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
    this.lastMoveVoiceAt = -999;
    this.lastMotorAt = -999;
    this.speechVoice = null;
    this.voiceAudio = null;
    this.voiceAudioUrl = null;
    this.voicePlaying = false;
    this.openAiVoiceDisabledUntil = 0;
    this.loopSamples = new Map();
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
    if (this.sfxMuted && typeof window !== 'undefined') {
      window.speechSynthesis?.cancel?.();
      this._stopVoiceAudio();
      for (const loop of this.loopSamples.values()) loop.el.pause();
      this.loopSamples.clear();
    }
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

  // Rauschstoß mit Filter-Sweep: heller Knall, der dunkel ausläuft (Explosionsschweif) oder
  // umgekehrt aufzischt (Raketenstart). Gibt SFX deutlich mehr Wucht und Charakter als ein Flat-Burst.
  _sweepNoise(vol, f0, f1, dur, q = 0.7, type = 'lowpass') {
    const t0 = this.ctx.currentTime;
    const src = this._noiseSource();
    const filt = this.ctx.createBiquadFilter();
    filt.type = type; filt.Q.value = q;
    filt.frequency.setValueAtTime(Math.max(40, f0), t0);
    filt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + dur);
    const g = this.ctx.createGain();
    this._env(g, t0, vol, dur, 0.003);
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

  _sampleSrc(entry) {
    return typeof entry === 'string' ? entry : entry?.src || '';
  }

  _sample(cat, vol = 1, rate = 1) {
    if (!this.ready || this.sfxMuted || vol <= 0.02) return false;
    const list = SFX_SAMPLES[cat];
    if (!list || !list.length) return false;
    const src = this._sampleSrc(list[(Math.random() * list.length) | 0]);
    if (!src) return false;
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
    const v = 0.38 * vol;
    switch (weapon) {
      case 'tank_cannon': case 'turret_cannon': case 'naval_gun': case 'artillery':
        // Harter Abschuss: scharfer Crack → kräftiger Sub-Boom mit Tonhöhenabfall → kurzer Mündungs-Schweif.
        this._sample('artillery', Math.min(0.28, v * 0.6), 0.9 + Math.random() * 0.12);
        this._burst(v * 0.55, 3200, 0.035, 1.0, 'highpass');
        this._thump(v * 1.25, 280, 46, 0.3);
        this._sweepNoise(v * 0.7, 1500, 220, 0.2, 0.6); break;
      case 'sam_missile': case 'aa_missile': case 'at_launcher': case 'torpedo': case 'micro_missile':
        // Raketenstart: aufzischender Sweep + Schub-Impuls.
        this._sample('missileFire', Math.min(0.24, v * 0.56), 0.95 + Math.random() * 0.1);
        this._sweepNoise(v * 0.6, 420, 2600, 0.34, 0.5, 'bandpass');
        this._thump(v * 0.4, 380, 110, 0.16); break;
      case 'rocket_salvo':
        this._sample('missileFire', Math.min(0.28, v * 0.62), 0.92 + Math.random() * 0.1);
        this._sweepNoise(v * 0.8, 520, 2900, 0.38, 0.5, 'bandpass');
        this._thump(v * 0.5, 300, 70, 0.22); break;
      case 'bomb':
        this._burst(v * 0.5, 3000, 0.04, 1.0, 'highpass');
        this._thump(v * 1.3, 170, 40, 0.42);
        this._sweepNoise(v * 0.7, 1200, 120, 0.4, 0.6); break;
      case 'flak_gun': case 'turret_flak': case 'turret_mg': case 'autocannon': case 'chain_gun':
        // Maschinenwaffe: knackiger Transient + kurzer Körper.
        this._sample('gunfire', Math.min(0.22, v * 0.48), 0.95 + Math.random() * 0.1);
        this._burst(v * 0.75, 2400, 0.045, 1.6, 'bandpass');
        this._thump(v * 0.4, 260, 110, 0.05); break;
      case 'cloud_seed':
        this._sample('laser', Math.min(0.22, v * 0.52), 0.9 + Math.random() * 0.16);
        this._sweepNoise(v * 0.5, 1800, 500, 0.26, 0.7, 'bandpass'); break;
      default: // rifle
        this._sample('shoot', Math.min(0.22, v * 0.55), 0.9 + Math.random() * 0.2);
        this._burst(v * 0.95, 3300, 0.035, 1.4, 'highpass');
        this._thump(v * 0.5, 340, 90, 0.06);
    }
  }

  explosion(scale = 1, vol = 1) {
    if (!this.ready || this.sfxMuted || vol <= 0.02) return;
    if (!this._budget('explosion', 8)) return;
    this.markCombat();
    const v = Math.min(0.95, 0.46 * vol * (0.7 + scale * 0.22));
    // Schichten: initialer Crack (Hochpass), tiefer Sub-Boom mit Tonhöhenabfall, heller→dunkler Rauschschweif.
    this._sample(scale > 1.15 ? 'missileBlast' : 'explosion', Math.min(0.38, v * 0.55), 0.82 + Math.random() * 0.14);
    this._burst(v * 0.5, 3200, 0.05, 1.1, 'highpass');
    this._thump(v * 1.2, 200 + 50 / scale, 26, 0.4 + scale * 0.14);
    this._sweepNoise(v * 0.85, 1700, 120, 0.38 + scale * 0.12, 0.6);
  }

  // Donnerschlag: Knall (Hochpass-Crack) + langes tiefes Grollen.
  thunder(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('thunder', 2)) return;
    this._sample('thunder', Math.min(0.34, 0.22 * vol), 0.96 + Math.random() * 0.08);
    this._burst(0.25 * vol, 2500, 0.08, 0.8, 'highpass');
    this._burst(0.28 * vol, 140, 1.6, 0.4);
    this._thump(0.24 * vol, 90, 28, 1.2);
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
    if (!this._sample('yes', 0.12 * vol, 0.94 + Math.random() * 0.08)) this._tone(0.12 * vol, 520, 0.08);
  }

  // Befehls-Quittung mit EIGENEM Klang je Einheitentyp: Grundton aus dem Namen-Hash (jeder Typ klingt
  // anders), Charakter aus Domäne/Kategorie, aber bewusst leise und kurz.
  unitAck(kind = '', category = 'vehicle', domain = 'land', vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('command', 3)) return;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 16777619) >>> 0;
    const semi = h % 12;
    const f = 300 * Math.pow(2, semi / 12);     // typeigener Grundton
    // Dezent & realistisch (statt arcade-artigem Rechteck-Piepen): leise, weiche/gefilterte Klänge.
    const v = 0.09 * vol;
    if (domain === 'air') {                       // weicher, leicht aufsteigender Funk-Ton
      this._tone(v * 0.9, f * 1.6, 0.09, 'sine'); this._tone(v * 0.7, f * 2.1, 0.10, 'sine', 0.06);
    } else if (domain === 'water') {              // tiefes, weiches Schiffshorn
      this._tone(v, f * 0.5, 0.24, 'sine'); this._tone(v * 0.6, f * 0.75, 0.18, 'sine', 0.10);
    } else if (category === 'infantry') {         // kurzes, gedämpftes Funk-Klick (kein Zwitschern)
      this._burst(v * 0.6, 1500, 0.035, 1.3, 'bandpass'); this._tone(v * 0.5, f * 1.4, 0.04, 'sine', 0.04);
    } else {                                      // Fahrzeug: weicher mechanischer Servo-Klick statt Piep
      this._burst(v * 0.7, 520, 0.05, 0.7); this._tone(v * 0.6, f, 0.06, 'triangle', 0.03);
    }
  }

  moveVoice(units = []) {
    if (this.sfxMuted || typeof window === 'undefined') return;
    if (this.voicePlaying || window.speechSynthesis?.speaking || window.speechSynthesis?.pending) return;
    const now = Date.now() / 1000;
    if (now - this.lastMoveVoiceAt < MOVE_VOICE_COOLDOWN) return;
    const group = this._moveVoiceGroup(units);
    const lines = COMMAND_VOICE_SAMPLES[group] || COMMAND_VOICE_SAMPLES.mixed;
    const line = lines[(Math.random() * lines.length) | 0];
    const text = line?.text || String(line || '');
    this.lastMoveVoiceAt = now;
    if (line?.src && this._playVoiceSample(line.src)) return;
    if (Date.now() >= this.openAiVoiceDisabledUntil) {
      this._openAiMoveVoice(text, group).then(ok => { if (!ok) this._browserMoveVoice(text); });
      return;
    }
    this._browserMoveVoice(text);
  }

  _browserMoveVoice(text) {
    if (this.sfxMuted || typeof window === 'undefined' || this.voicePlaying) return false;
    const synth = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synth || !Utterance || synth.speaking || synth.pending) return false;
    const utter = new Utterance(text);
    utter.lang = 'de-DE';
    utter.volume = 1.0;
    utter.rate = 1.04 + Math.random() * 0.08;
    utter.pitch = 0.92 + Math.random() * 0.16;
    const voice = this._speechVoice();
    if (voice) utter.voice = voice;
    synth.speak(utter);
    return true;
  }

  _playVoiceSample(src) {
    if (this.sfxMuted || typeof window === 'undefined' || this.voicePlaying || !window.Audio) return false;
    try {
      const audio = new window.Audio(src);
      audio.preload = 'auto';
      audio.volume = 1.0;
      audio.playbackRate = 0.98 + Math.random() * 0.04;
      this._stopVoiceAudio();
      this.voiceAudio = audio;
      this.voiceAudioUrl = null;
      this.voicePlaying = true;
      const cleanup = () => {
        if (this.voiceAudio === audio) this._stopVoiceAudio();
      };
      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', cleanup, { once: true });
      const play = audio.play();
      if (play?.catch) play.catch(cleanup);
      return true;
    } catch {
      this._stopVoiceAudio();
      return false;
    }
  }

  async _openAiMoveVoice(text, group) {
    if (!window.fetch || this.voicePlaying) return false;
    try {
      const res = await fetch('/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, group }),
      });
      if (!res.ok) {
        this.openAiVoiceDisabledUntil = Date.now() + (res.status === 503 || res.status === 404 ? 300000 : 20000);
        return false;
      }
      if (this.sfxMuted) return true;
      const blob = await res.blob();
      if (!blob.size) return false;
      const url = URL.createObjectURL(blob);
      const audio = new window.Audio(url);
      audio.volume = 1.0;
      this._stopVoiceAudio();
      this.voiceAudio = audio;
      this.voiceAudioUrl = url;
      this.voicePlaying = true;
      const cleanup = () => {
        if (this.voiceAudio === audio) this._stopVoiceAudio();
        else URL.revokeObjectURL(url);
      };
      audio.addEventListener('ended', cleanup, { once: true });
      audio.addEventListener('error', cleanup, { once: true });
      await audio.play();
      return true;
    } catch {
      this.openAiVoiceDisabledUntil = Date.now() + 20000;
      this._stopVoiceAudio();
      return false;
    }
  }

  _stopVoiceAudio() {
    if (this.voiceAudio) {
      this.voiceAudio.pause();
      this.voiceAudio.removeAttribute?.('src');
      this.voiceAudio.load?.();
    }
    if (this.voiceAudioUrl) URL.revokeObjectURL(this.voiceAudioUrl);
    this.voiceAudio = null;
    this.voiceAudioUrl = null;
    this.voicePlaying = false;
  }

  _moveVoiceGroup(units = []) {
    const live = units.filter(u => u && u.kind);
    if (!live.length) return 'mixed';
    const domains = new Set(live.map(u => u.domain || 'land'));
    const categories = new Set(live.map(u => u.category || 'vehicle'));
    if (domains.size > 1 || categories.size > 1) return 'mixed';
    const u = live[0];
    if (u.domain === 'air') return 'air';
    if (u.domain === 'water') return 'water';
    if (u.category === 'infantry') return 'infantry';
    if (u.kind === 'builder') return 'builder';
    if (u.kind === 'truck' || u.kind === 'harvester') return 'truck';
    return 'vehicle';
  }

  _speechVoice() {
    if (this.speechVoice) return this.speechVoice;
    const voices = window.speechSynthesis?.getVoices?.() || [];
    this.speechVoice = voices.find(v => /^de[-_]/i.test(v.lang))
      || voices.find(v => /deutsch|german/i.test(`${v.name} ${v.lang}`))
      || voices[0]
      || null;
    return this.speechVoice;
  }

  motor(unitsOrVol = 1, volArg = null) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('motor', 1)) return;
    const now = this.ctx.currentTime;
    if (now - this.lastMotorAt < MOTOR_COOLDOWN) return;
    this.lastMotorAt = now;
    const units = Array.isArray(unitsOrVol) ? unitsOrVol : [];
    const vol = Array.isArray(unitsOrVol) ? (volArg ?? 1) : unitsOrVol;
    const air = units.find(u => u.domain === 'air');
    const tracked = units.find(u => u.heavy || u.kind === 'tank' || u.kind === 'artillery' || u.kind === 'rocket_launcher');
    if (air) {
      const cat = air.kind === 'gunship' ? 'helicopter' : 'plane';
      this._sample(cat, Math.min(0.14, 0.11 * vol), 0.96 + Math.random() * 0.08);
    } else if (tracked) {
      this._sample('vehicleTrack', Math.min(0.09, 0.08 * vol), 0.94 + Math.random() * 0.08);
    }
    const v = Math.min(0.024, 0.016 * vol);
    this._burst(v, 135, 0.055, 0.28);
    this._thump(v * 0.42, 88, 58, 0.075);
  }

  excavate(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    if (!this._budget('excavator', 1)) return;
    const v = Math.min(0.07, 0.055 * vol);
    this._burst(v, 280, 0.08, 0.55);
    this._thump(v * 0.55, 125, 78, 0.10);
  }

  _loopSample(key, cat, vol) {
    const existing = this.loopSamples.get(key);
    if (!cat || this.sfxMuted || vol <= 0.01) {
      if (existing) {
        existing.el.pause();
        existing.el.removeAttribute?.('src');
        existing.el.load?.();
        this.loopSamples.delete(key);
      }
      return;
    }
    const list = SFX_SAMPLES[cat] || [];
    const src = this._sampleSrc(list[0]);
    if (!src || typeof window === 'undefined' || !window.Audio) return;
    if (existing?.src === src) {
      existing.el.volume = Math.max(0, Math.min(1, vol));
      return;
    }
    if (existing) existing.el.pause();
    const el = new window.Audio(src);
    el.loop = true;
    el.preload = 'auto';
    el.volume = Math.max(0, Math.min(1, vol));
    this.loopSamples.set(key, { src, el });
    el.play().catch(() => {});
  }

  // Dauerregen als gefilterte Rauschschleife; Lautstärke folgt der Wetterlage.
  setWeather(w) {
    if (!this.ready) return;
    const weatherCat = w === 'storm' ? 'rainThunder' : w === 'rain' ? 'rain' : null;
    this._loopSample('weather', weatherCat, w === 'storm' ? 0.09 : w === 'rain' ? 0.06 : 0);
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
    const target = this.sfxMuted || weatherCat ? 0 : w === 'storm' ? 0.10 : w === 'rain' ? 0.055 : 0;
    const t = this.ctx.currentTime;
    this._rain.gain.cancelScheduledValues(t);
    this._rain.gain.linearRampToValueAtTime(target, t + 1.5);
  }

  build(vol = 1) {
    if (!this.ready || this.sfxMuted) return;
    this._sample('construction', 0.08 * vol, 0.95 + Math.random() * 0.08);
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
