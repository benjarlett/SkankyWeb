import { getFile } from './db.js';

// Try to load SoundTouch (WSOLA — much better quality than phase vocoder).
// Dynamic import so a CDN failure degrades gracefully instead of crashing.
let _st = null;
import('https://cdn.jsdelivr.net/npm/soundtouch-js@0.1.1/dist/soundtouch.esm.js')
  .then(m  => { _st = m; })
  .catch(() => console.warn('SoundTouch unavailable — using native pitch'));

// ── State ──────────────────────────────────────────────────────────────────

let ctx         = null;
let currentNode = null;   // ScriptProcessorNode (SoundTouch) or AudioBufferSourceNode
let currentST   = null;   // SoundTouch instance — kept for live updatePitch()
let endTimer    = null;

export let currentLoopId = null;
export let isPlaying     = false;

// ── AudioContext ───────────────────────────────────────────────────────────

function getCtx() {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
  return ctx;
}

// ── Play ───────────────────────────────────────────────────────────────────

export async function play(loopId, filename, data) {
  await stop();

  const blob = await getFile(filename);
  if (!blob) return false;

  const audioCtx = getCtx();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const audioBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
  const duration    = audioBuffer.duration;
  const looping     = !!data.looping;
  const semitones   = (data.transposeSemitones || 0) + (data.tuneCents || 0) / 100;

  if (Math.abs(semitones) < 0.01) {
    // ── No shift: native playback, zero quality loss ───────────────────────
    _playNative(audioCtx, audioBuffer, looping, 1);
    if (!looping) endTimer = setTimeout(() => _finish(loopId), duration * 1000 + 300);

  } else if (_st) {
    // ── SoundTouch WSOLA: pitch-preserving, minimal artefacts ─────────────
    const { SoundTouch, SimpleFilter, getWebAudioNode } = _st;
    const st = new SoundTouch();
    st.pitchSemitones = semitones;
    st.tempo          = 1.0;
    currentST = st;

    const filter = new SimpleFilter(_makeSource(audioBuffer, looping), st);
    const node   = getWebAudioNode(audioCtx, filter, 4096);
    node.connect(audioCtx.destination);
    currentNode = node;
    if (!looping) endTimer = setTimeout(() => _finish(loopId), duration * 1000 + 1500);

  } else {
    // ── Fallback: native playbackRate (changes tempo slightly too) ─────────
    const rate = Math.pow(2, semitones / 12);
    _playNative(audioCtx, audioBuffer, looping, rate);
    if (!looping) endTimer = setTimeout(() => _finish(loopId), (duration / rate) * 1000 + 300);
  }

  currentLoopId = loopId;
  isPlaying     = true;
  return true;
}

function _playNative(audioCtx, audioBuffer, looping, rate) {
  const src = audioCtx.createBufferSource();
  src.buffer            = audioBuffer;
  src.loop              = looping;
  src.playbackRate.value = rate;
  src.connect(audioCtx.destination);
  src.start();
  currentNode = src;
  currentST   = null;
}

// ── Stop ───────────────────────────────────────────────────────────────────

export async function stop() {
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  if (currentNode) {
    try {
      if (currentNode.stop) currentNode.stop();
      currentNode.disconnect();
    } catch (_) {}
    currentNode = null;
  }
  currentST     = null;
  currentLoopId = null;
  isPlaying     = false;
}

// ── Live pitch update (edit modal sliders) ─────────────────────────────────

export function updatePitch(semitones, cents) {
  const total = semitones + cents / 100;
  if (currentST) {
    currentST.pitchSemitones = total;
  } else if (currentNode?.playbackRate) {
    currentNode.playbackRate.value = Math.pow(2, total / 12);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _finish(loopId) {
  if (currentLoopId !== loopId) return;
  stop().then(() =>
    document.dispatchEvent(new CustomEvent('playbackEnded', { detail: { loopId } }))
  );
}

// Adapter: provides AudioBuffer samples to SoundTouch SimpleFilter.
// extract(target, numFrames, absolutePosition) → framesWritten
// target is interleaved stereo Float32Array: [L0,R0, L1,R1, ...]
function _makeSource(audioBuffer, looping) {
  const left  = audioBuffer.getChannelData(0);
  const right  = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
  const total  = left.length;

  return {
    extract(target, numFrames, position) {
      let count = 0;
      for (let i = 0; i < numFrames; i++) {
        let idx = position + i;
        if (looping)        idx = idx % total;
        else if (idx >= total) break;
        target[i * 2]     = left[idx];
        target[i * 2 + 1] = right[idx];
        count++;
      }
      return count;
    },
  };
}
