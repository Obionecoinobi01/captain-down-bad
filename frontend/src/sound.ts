/**
 * sound.ts — Web Audio engine for Captain Down Bad.
 *
 * Two audio systems:
 *   1. Real MP3 track  — intro/loading screen  (HTML Audio element, loops)
 *   2. Procedural SFX  — in-game events         (Web Audio API oscillators + noise)
 *   3. Procedural music — in-game background    (Web Audio API chiptune loop)
 *
 * Architecture: two gain buses so music can fade independently of SFX.
 *   AudioContext → sfxBus  (always full volume)
 *                → musicBus (procedural in-game chiptune)
 */

// ── AudioContext + buses ───────────────────────────────────────────────────────

let _ctx:       AudioContext | null = null
let _sfxBus:    GainNode     | null = null
let _musicBus:  GainNode     | null = null
let _musicLoop: ReturnType<typeof setTimeout> | null = null
let _musicActive = false

function boot(): { ctx: AudioContext; sfx: GainNode; music: GainNode } {
  if (!_ctx) {
    _ctx      = new AudioContext()
    _sfxBus   = _ctx.createGain();  _sfxBus.gain.value  = 0.55
    _musicBus = _ctx.createGain();  _musicBus.gain.value = 0.30
    _sfxBus.connect(_ctx.destination)
    _musicBus.connect(_ctx.destination)
  }
  if (_ctx.state === 'suspended') _ctx.resume()
  return { ctx: _ctx, sfx: _sfxBus!, music: _musicBus! }
}

// ── Low-level primitives ───────────────────────────────────────────────────────

type OscType = OscillatorType

/** Schedule a pitched oscillator note. */
function osc(
  freq:     number,
  type:     OscType,
  start:    number,
  duration: number,
  vol:      number,
  freqEnd?: number,
  dest?:    AudioNode,
) {
  const { ctx, sfx } = boot()
  const g = ctx.createGain()
  g.gain.setValueAtTime(vol, start)
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  g.connect(dest ?? sfx)

  const o = ctx.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(freq, start)
  if (freqEnd !== undefined)
    o.frequency.exponentialRampToValueAtTime(freqEnd, start + duration)
  o.connect(g)
  o.start(start)
  o.stop(start + duration + 0.01)
}

/** Schedule a white-noise hit (percussion / impact). */
function noise(start: number, duration: number, vol: number, dest?: AudioNode) {
  const { ctx, sfx } = boot()
  const len = Math.ceil(ctx.sampleRate * duration)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const ch  = buf.getChannelData(0)
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1

  const g = ctx.createGain()
  g.gain.setValueAtTime(vol, start)
  g.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  g.connect(dest ?? sfx)

  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(g)
  src.start(start)
}

// ── Sound effects ──────────────────────────────────────────────────────────────

/** Gem collected — rising two-note chirp. */
export function playGemCollect() {
  const t = boot().ctx.currentTime
  osc(659, 'square', t,        0.07, 0.32)   // E5
  osc(880, 'square', t + 0.07, 0.14, 0.28)   // A5
}

/** Player jumps — upward frequency sweep. */
export function playJump() {
  const t = boot().ctx.currentTime
  osc(180, 'square', t, 0.18, 0.22, 580)
}

/** Punch lands — sharp noise thud + pitch drop. */
export function playPunch() {
  const t = boot().ctx.currentTime
  noise(t, 0.05, 0.45)
  osc(200, 'square', t, 0.08, 0.20, 70)
}

/** Kick lands — lower thud, slightly longer. */
export function playKick() {
  const t = boot().ctx.currentTime
  noise(t, 0.08, 0.55)
  osc(120, 'square', t, 0.10, 0.28, 45)
}

/** Player takes damage — descending wail + noise. */
export function playHurt() {
  const t = boot().ctx.currentTime
  osc(440, 'square', t,        0.06, 0.30)
  osc(300, 'square', t + 0.06, 0.14, 0.26)
  noise(t, 0.09, 0.20)
}

/** Enemy defeated — rising arpeggio C4→E4→G4→C5. */
export function playEnemyDefeat() {
  const t = boot().ctx.currentTime
  ;[262, 330, 392, 523].forEach((f, i) =>
    osc(f, 'square', t + i * 0.07, 0.10, 0.32),
  )
}

/** Game over — slow descending pentatonic descent. */
export function playGameOver() {
  const t = boot().ctx.currentTime
  ;[494, 440, 392, 330, 294, 247].forEach((f, i) =>
    osc(f, 'triangle', t + i * 0.22, 0.30, 0.35),
  )
}

/** Victory — classic fanfare arpeggio. */
export function playWin() {
  const t = boot().ctx.currentTime
  const seq: [number, number][] = [
    [262, 0.10], [262, 0.10], [262, 0.10], [330, 0.30],
    [294, 0.10], [294, 0.10], [294, 0.10], [349, 0.30],
    [392, 0.15], [330, 0.15], [349, 0.15], [392, 0.55],
  ]
  let when = t
  for (const [f, dur] of seq) {
    osc(f, 'square', when, dur * 0.85, 0.38)
    when += dur
  }
}

/** UI click / menu confirm — short blip. */
export function playUIClick() {
  const t = boot().ctx.currentTime
  osc(880, 'square', t, 0.05, 0.18)
}

// ── Music engine ───────────────────────────────────────────────────────────────
// Driving Am chiptune: 4-bar loop, bass + lead + drums.
// intro mode (BPM 132) = chill title vibe
// game  mode (BPM 148) = combat intensity

const NOTE: Record<string, number> = {
  A2: 110.0, C3: 130.8, D3: 146.8, E3: 164.8, F3: 174.6, G3: 196.0,
  A3: 220.0, B3: 246.9, C4: 261.6, D4: 293.7, E4: 329.6,
  F4: 349.2, G4: 392.0, A4: 440.0,
}

// Step = [frequency_hz, sixteenth_notes, volume]
type Step = [number, number, number]

// Bass — 4 bars of Am groove (64 sixteenth notes total)
const BASS: Step[] = [
  // Bar 1  Am
  [NOTE.A2, 4, 0.30], [NOTE.E3, 2, 0.26], [NOTE.A2, 2, 0.28],
  [NOTE.C3, 4, 0.28], [NOTE.E3, 4, 0.30],
  // Bar 2  F → C
  [NOTE.F3, 4, 0.30], [NOTE.A3, 2, 0.26], [NOTE.F3, 2, 0.28],
  [NOTE.C3, 4, 0.28], [NOTE.G3, 4, 0.30],
  // Bar 3  Am → E
  [NOTE.A2, 4, 0.30], [NOTE.E3, 4, 0.30],
  [NOTE.A2, 4, 0.28], [NOTE.E3, 4, 0.30],
  // Bar 4  F → Am
  [NOTE.F3, 4, 0.30], [NOTE.G3, 4, 0.28],
  [NOTE.A2, 8, 0.32],
]

// Lead melody — same 4-bar span
const LEAD: Step[] = [
  // Bar 1
  [NOTE.E4, 2, 0.26], [NOTE.D4, 2, 0.22], [NOTE.C4, 2, 0.24], [NOTE.A3, 2, 0.26],
  [NOTE.C4, 2, 0.24], [NOTE.D4, 2, 0.24], [NOTE.E4, 2, 0.26], [NOTE.A4, 2, 0.30],
  // Bar 2
  [NOTE.G4, 2, 0.26], [NOTE.F4, 2, 0.22], [NOTE.E4, 2, 0.26], [NOTE.D4, 2, 0.22],
  [NOTE.C4, 2, 0.24], [NOTE.B3, 2, 0.22], [NOTE.A3, 4, 0.28],
  // Bar 3
  [NOTE.E4, 2, 0.26], [NOTE.D4, 2, 0.22], [NOTE.C4, 2, 0.24], [NOTE.A3, 2, 0.26],
  [NOTE.E4, 2, 0.26], [NOTE.G4, 2, 0.26], [NOTE.A4, 4, 0.30],
  // Bar 4
  [NOTE.G4, 2, 0.26], [NOTE.F4, 2, 0.22], [NOTE.E4, 2, 0.26], [NOTE.D4, 2, 0.22],
  [NOTE.C4, 2, 0.24], [NOTE.B3, 2, 0.22], [NOTE.A3, 4, 0.30],
]

function scheduleSteps(steps: Step[], start: number, bpm: number, type: OscType, dest: AudioNode) {
  const sixteenth = (60 / bpm) / 4
  let when = start
  for (const [freq, sixteenths, vol] of steps) {
    const dur = sixteenths * sixteenth
    if (freq > 0) osc(freq, type, when, dur * 0.78, vol, undefined, dest)
    when += dur
  }
  return when   // returns end time of this sequence
}

function scheduleDrums(start: number, bpm: number, bars: number, dest: AudioNode) {
  const beat = 60 / bpm
  const beats = bars * 4
  for (let b = 0; b < beats; b++) {
    const t = start + b * beat
    // Hi-hat on every 8th note (quiet)
    noise(t,              0.035, 0.07, dest)
    noise(t + beat / 2,  0.035, 0.055, dest)
    // Kick on beats 1 & 3
    if (b % 4 === 0 || b % 4 === 2) {
      osc(85,  'sine', t, beat * 0.45, 0.32, 28, dest)
      noise(t, 0.04, 0.22, dest)
    }
    // Snare on beats 2 & 4
    if (b % 4 === 1 || b % 4 === 3) {
      noise(t, 0.13, 0.28, dest)
      osc(220, 'square', t, 0.06, 0.13, undefined, dest)
    }
  }
}

function schedulePattern(startAt: number, bpm: number) {
  if (!_musicActive) return
  const { ctx, music } = boot()
  const bars = 4

  scheduleSteps(BASS, startAt, bpm, 'square', music)
  scheduleSteps(LEAD, startAt, bpm, 'square', music)
  scheduleDrums(startAt, bpm, bars, music)

  // Loop duration in seconds
  const loopDur = bars * 4 * (60 / bpm)   // 4 bars × 4 beats × beat_len
  const nextAt  = startAt + loopDur

  // Re-schedule 200 ms before loop end so there's no gap
  const delay   = Math.max(0, (nextAt - ctx.currentTime - 0.2) * 1000)
  _musicLoop = setTimeout(() => schedulePattern(nextAt, bpm), delay)
}

/** Start the background music.
 *  @param variant  'intro' (slower, relaxed) | 'game' (faster, intense) */
export function startMusic(variant: 'intro' | 'game' = 'intro') {
  if (_musicActive) return
  _musicActive = true
  const { ctx, music } = boot()
  music.gain.setValueAtTime(0, ctx.currentTime)
  music.gain.linearRampToValueAtTime(0.30, ctx.currentTime + 0.8)  // fade in
  schedulePattern(ctx.currentTime + 0.05, variant === 'game' ? 148 : 132)
}

/** Stop procedural music with a short fade-out. */
export function stopMusic() {
  _musicActive = false
  if (_musicLoop !== null) { clearTimeout(_musicLoop); _musicLoop = null }
  if (_musicBus && _ctx) {
    _musicBus.gain.setValueAtTime(_musicBus.gain.value, _ctx.currentTime)
    _musicBus.gain.linearRampToValueAtTime(0, _ctx.currentTime + 0.6)
    // Reset for next start
    setTimeout(() => { if (_musicBus) _musicBus.gain.setValueAtTime(0.30, _ctx!.currentTime) }, 700)
  }
}

// ── Real MP3 intro track ───────────────────────────────────────────────────────

let _introAudio: HTMLAudioElement | null = null
let _fadeTimer:  ReturnType<typeof setInterval> | null = null

function clearFadeTimer() {
  if (_fadeTimer !== null) { clearInterval(_fadeTimer); _fadeTimer = null }
}

/**
 * Play `/audio/soundtrack.mp3` looping on the intro screen.
 * Fades in over ~1 second. Must be called from a user gesture.
 */
export function startIntroTrack() {
  clearFadeTimer()
  if (!_introAudio) {
    _introAudio       = new Audio('/audio/soundtrack.mp3')
    _introAudio.loop  = true
  }
  _introAudio.volume  = 0
  _introAudio.play().catch(() => { /* blocked by autoplay policy — silently ignored */ })

  // Fade in to 0.75 over ~1 s (20 steps × 50 ms)
  let step = 0
  const TARGET = 0.75
  _fadeTimer = setInterval(() => {
    step++
    if (_introAudio) _introAudio.volume = Math.min(TARGET, (step / 20) * TARGET)
    if (step >= 20) clearFadeTimer()
  }, 50)
}

/**
 * Fade out and pause the intro track over ~0.6 s.
 */
export function stopIntroTrack() {
  clearFadeTimer()
  if (!_introAudio) return
  const start = _introAudio.volume
  let step = 0
  _fadeTimer = setInterval(() => {
    step++
    if (_introAudio) _introAudio.volume = Math.max(0, start * (1 - step / 12))
    if (step >= 12) {
      clearFadeTimer()
      _introAudio?.pause()
    }
  }, 50)
}
