import { getFile } from './db.js';

// ── State ──────────────────────────────────────────────────────────────────

let ctx         = null;
let currentSrc  = null;   // AudioBufferSourceNode
let endTimer    = null;
let playToken   = 0;      // incremented on every play(); stale async calls bail out

export let currentLoopId = null;
export let isPlaying     = false;

// ── AudioContext ───────────────────────────────────────────────────────────

function getCtx() {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
  return ctx;
}

// ── Play ───────────────────────────────────────────────────────────────────

export async function play(loopId, filename, data) {
  const token = ++playToken;
  await stop();

  const blob = await getFile(filename);
  if (token !== playToken) return false; // a newer play() was requested while loading
  if (!blob) return false;

  const audioCtx = getCtx();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const raw      = await audioCtx.decodeAudioData(await blob.arrayBuffer());
  const semitones = (data.transposeSemitones || 0) + (data.tuneCents || 0) / 100;
  const looping   = !!data.looping;

  const buffer = Math.abs(semitones) < 0.01 ? raw : pvShift(raw, semitones);

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.loop   = looping;
  src.connect(audioCtx.destination);
  src.start();

  currentSrc    = src;
  currentLoopId = loopId;
  isPlaying     = true;

  if (!looping) {
    endTimer = setTimeout(() => _finish(loopId), buffer.duration * 1000 + 300);
  }

  return true;
}

// ── Stop ───────────────────────────────────────────────────────────────────

export async function stop() {
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (currentSrc) {
    try { currentSrc.stop(); currentSrc.disconnect(); } catch (_) {}
    currentSrc = null;
  }
  currentLoopId = null;
  isPlaying     = false;
}

export function updatePitch() {}

// ── Internal helpers ───────────────────────────────────────────────────────

function _finish(loopId) {
  if (currentLoopId !== loopId) return;
  stop().then(() =>
    document.dispatchEvent(new CustomEvent('playbackEnded', { detail: { loopId } }))
  );
}

// ── Phase vocoder pitch shifter ────────────────────────────────────────────
//
// Algorithm (offline, no external libraries):
//   1. Phase-vocoder TIME-STRETCH the input by α using STFT phase accumulation.
//      Output length = ceil(inLen × α).  Pitch is unchanged; duration changes.
//   2. RESAMPLE (cubic) the stretched buffer back to inLen.
//      Reading at rate α compresses/expands the waveform periods → pitch shifts.
//
// This two-step approach is used by professional tools (Rubber Band, SoundTouch
// "high quality" mode).  The phase vocoder in step 1 tracks the instantaneous
// frequency of every spectral bin, so it maintains phase coherence across
// overlapping frames—eliminating the "FM / chorus / comb filter" artefacts
// that plain OLA produces on tonal content like bass guitar.

const N     = 2048;  // FFT frame size
const Ha    = 512;   // analysis hop (75 % overlap)

// Pre-compute Hann window once
const _hann = new Float32Array(N);
for (let i = 0; i < N; i++) _hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N));

// Radix-2 in-place FFT/IFFT
function fftInPlace(re, im, inverse) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t     = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Cooley–Tukey butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const ang  = (inverse ? 2 : -2) * Math.PI / len;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < (len >> 1); j++) {
        const u = i + j, v = i + j + (len >> 1);
        const tRe = cr * re[v] - ci * im[v];
        const tIm = cr * im[v] + ci * re[v];
        re[v] = re[u] - tRe;  im[v] = im[u] - tIm;
        re[u] += tRe;         im[u] += tIm;
        const nr = cr * cosA - ci * sinA;
        ci = cr * sinA + ci * cosA;
        cr = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

function pvShift(inputBuffer, semitones) {
  const alpha   = Math.pow(2, semitones / 12);
  const numCh   = inputBuffer.numberOfChannels;
  const inLen   = inputBuffer.length;
  const sr      = inputBuffer.sampleRate;
  const Hs      = Math.max(1, Math.round(Ha * alpha)); // synthesis hop
  const strLen  = Math.ceil(inLen * alpha);            // stretched length

  // Pre-allocate reusable per-frame arrays (avoid GC pressure)
  const fRe   = new Float32Array(N);
  const fIm   = new Float32Array(N);
  const oRe   = new Float32Array(N);
  const oIm   = new Float32Array(N);

  const outBuffer = ctx.createBuffer(numCh, inLen, sr);

  for (let c = 0; c < numCh; c++) {
    const input     = inputBuffer.getChannelData(c);
    const stretched = new Float32Array(strLen);
    const weight    = new Float32Array(strLen);

    // Phase state (per-channel)
    const phiPrev  = new Float32Array((N >> 1) + 1);
    const phiAccum = new Float32Array((N >> 1) + 1);
    let firstFrame = true;

    let analPos = 0;
    let synthPos = 0;

    while (synthPos < strLen) {
      // --- Analysis: windowed frame from input --------------------------------
      fRe.fill(0); fIm.fill(0);
      for (let i = 0; i < N; i++) {
        const idx = analPos + i;
        if (idx < inLen) fRe[i] = input[idx] * _hann[i];
      }

      fftInPlace(fRe, fIm, false);

      // --- Phase processing: track instantaneous frequency -------------------
      oRe.fill(0); oIm.fill(0);
      const half = N >> 1;
      for (let k = 0; k <= half; k++) {
        const mag   = Math.sqrt(fRe[k] * fRe[k] + fIm[k] * fIm[k]);
        const phase = Math.atan2(fIm[k], fRe[k]);

        if (firstFrame) {
          phiAccum[k] = phase;
        } else {
          // Phase deviation from the expected advance at bin-centre frequency
          let dPhi = phase - phiPrev[k] - (2 * Math.PI * k / N) * Ha;
          // Wrap to [-π, π]
          dPhi -= 2 * Math.PI * Math.round(dPhi / (2 * Math.PI));
          // True instantaneous frequency × synthesis hop = phase advance
          phiAccum[k] += (2 * Math.PI * k / N + dPhi / Ha) * Hs;
        }

        phiPrev[k] = phase;
        oRe[k] = mag * Math.cos(phiAccum[k]);
        oIm[k] = mag * Math.sin(phiAccum[k]);
      }
      firstFrame = false;

      // Mirror for real-valued IFFT
      for (let k = 1; k < half; k++) {
        oRe[N - k] =  oRe[k];
        oIm[N - k] = -oIm[k];
      }

      fftInPlace(oRe, oIm, true);

      // --- Synthesis: overlap-add --------------------------------------------
      for (let i = 0; i < N; i++) {
        const si = synthPos + i;
        if (si < strLen) {
          stretched[si] += oRe[i] * _hann[i];
          weight[si]    += _hann[i] * _hann[i];
        }
      }

      analPos  += Ha;
      synthPos += Hs;
    }

    // Normalise stretched buffer
    for (let i = 0; i < strLen; i++) {
      if (weight[i] > 1e-6) stretched[i] /= weight[i];
    }

    // --- Cubic resample from strLen → inLen (changes pitch) -----------------
    const ch    = outBuffer.getChannelData(c);
    const scale = (strLen - 1) / Math.max(inLen - 1, 1);
    for (let i = 0; i < inLen; i++) {
      const pos = i * scale;
      const j   = pos | 0;
      const t   = pos - j;
      const p0  = j > 0          ? stretched[j - 1] : stretched[0];
      const p1  = stretched[j];
      const p2  = j + 1 < strLen ? stretched[j + 1] : stretched[strLen - 1];
      const p3  = j + 2 < strLen ? stretched[j + 2] : stretched[strLen - 1];
      const a   = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
      const b   =  p0 - 2.5 * p1 + 2   * p2 - 0.5 * p3;
      const cc  = -0.5 * p0 + 0.5 * p2;
      ch[i] = a * t * t * t + b * t * t + cc * t + p1;
    }
  }

  return outBuffer;
}
