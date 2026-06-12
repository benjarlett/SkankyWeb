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

  // Apply offline OLA pitch shift if needed; otherwise play raw
  const buffer = Math.abs(semitones) < 0.01
    ? raw
    : olaShift(raw, semitones);

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

// ── Live pitch update — not applicable to offline approach ─────────────────
// (Slider live-preview fires while stopped; re-play will pick up new value.)
export function updatePitch() {}

// ── Internal helpers ───────────────────────────────────────────────────────

function _finish(loopId) {
  if (currentLoopId !== loopId) return;
  stop().then(() =>
    document.dispatchEvent(new CustomEvent('playbackEnded', { detail: { loopId } }))
  );
}

// ── OLA pitch shifter ──────────────────────────────────────────────────────
// Offline Overlap-Add pitch shift.  No external libraries.
//
// Algorithm:
//   1. Linear-interpolation resample by 1/α  → same pitch, different duration
//      (simulates playback at rate α)
//   2. OLA time-stretch back to original duration
//      → pitch shifted, original tempo
//
// Quality is much better than a real-time granular approach because:
//   • No audible echo (processing is offline — no overlapping "echoes")
//   • No metallic artefacts from fixed grain boundaries
//   • Smooth Hann-windowed overlap with proper normalisation
//
// Frame / hop chosen for 75 % overlap at typical shifts ≤ 12 semitones.

function olaShift(inputBuffer, semitones) {
  const alpha   = Math.pow(2, semitones / 12); // pitch ratio
  const numCh   = inputBuffer.numberOfChannels;
  const inLen   = inputBuffer.length;
  const sr      = inputBuffer.sampleRate;

  // After resampling by 1/α the buffer has resLen samples
  const resLen  = Math.max(1, Math.round(inLen / alpha));

  // OLA parameters — 75 % overlap (hopOut ≈ frameSize/4 after stretch)
  const FRAME   = 2048;
  const HOP_IN  = 512;
  const HOP_OUT = Math.max(1, Math.round(HOP_IN * (inLen / resLen)));

  // Hann window (periodic form)
  const hann = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / FRAME));
  }

  const outBuffer = ctx.createBuffer(numCh, inLen, sr);

  for (let c = 0; c < numCh; c++) {
    const input = inputBuffer.getChannelData(c);

    // Step 1 — resample
    const res = new Float32Array(resLen);
    for (let i = 0; i < resLen; i++) {
      const pos = i * alpha;
      const lo  = pos | 0;
      const frac = pos - lo;
      res[i] = lo + 1 < inLen
        ? input[lo] + frac * (input[lo + 1] - input[lo])
        : (lo < inLen ? input[lo] : 0);
    }

    // Step 2 — OLA time-stretch
    const out    = new Float32Array(inLen);
    const weight = new Float32Array(inLen);

    let inPos  = 0;
    let outPos = 0;

    while (inPos + FRAME <= resLen && outPos < inLen) {
      const end = Math.min(FRAME, inLen - outPos);
      for (let i = 0; i < end; i++) {
        const w = hann[i];
        out[outPos + i]    += res[inPos + i] * w;
        weight[outPos + i] += w;
      }
      inPos  += HOP_IN;
      outPos += HOP_OUT;
    }

    // Normalise by window accumulation (avoids amplitude ripple)
    const ch = outBuffer.getChannelData(c);
    for (let i = 0; i < inLen; i++) {
      ch[i] = weight[i] > 1e-4 ? out[i] / weight[i] : 0;
    }
  }

  return outBuffer;
}
