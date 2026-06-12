import { getFile } from './db.js';
import { SoundTouch, SimpleFilter, getWebAudioNode }
  from 'https://cdn.jsdelivr.net/npm/soundtouch-js@0.1.1/dist/soundtouch.esm.js';

// ── State ──────────────────────────────────────────────────────────────────

let ctx         = null;   // AudioContext (created lazily on first play)
let currentNode = null;   // ScriptProcessorNode (SoundTouch) or AudioBufferSourceNode
let currentST   = null;   // SoundTouch instance — kept for live pitch updates
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
  // iOS requires resume() inside a user-gesture handler
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const audioBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
  const duration    = audioBuffer.duration;
  const looping     = !!data.looping;
  const semitones   = (data.transposeSemitones || 0) + (data.tuneCents || 0) / 100;

  if (Math.abs(semitones) < 0.01) {
    // No shift — native playback, zero quality loss
    const src = audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.loop   = looping;
    src.connect(audioCtx.destination);
    src.start();
    currentNode = src;
    currentST   = null;

    if (!looping) {
      endTimer = setTimeout(() => _finish(loopId), duration * 1000 + 300);
    }
  } else {
    // SoundTouch WSOLA — pitch-preserving, much less artefact than phase vocoder
    const st = new SoundTouch();
    st.pitchSemitones = semitones;
    st.tempo          = 1.0;
    currentST = st;

    const filter = new SimpleFilter(_makeSource(audioBuffer, looping), st);
    const node   = getWebAudioNode(audioCtx, filter, 4096);
    node.connect(audioCtx.destination);
    currentNode = node;

    if (!looping) {
      // Extra margin for SoundTouch internal latency flush
      endTimer = setTimeout(() => _finish(loopId), duration * 1000 + 1500);
    }
  }

  currentLoopId = loopId;
  isPlaying     = true;
  return true;
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

// ── Live pitch update (from edit modal sliders) ────────────────────────────

export function updatePitch(semitones, cents) {
  if (currentST) currentST.pitchSemitones = semitones + cents / 100;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function _finish(loopId) {
  if (currentLoopId !== loopId) return;
  stop().then(() =>
    document.dispatchEvent(new CustomEvent('playbackEnded', { detail: { loopId } }))
  );
}

// Adapter: wraps an AudioBuffer into the interface SoundTouch SimpleFilter expects.
// extract(target, numFrames, absoluteSamplePosition) → framesWritten
// target is a flat Float32Array: [L0, R0, L1, R1, ...]
function _makeSource(audioBuffer, looping) {
  const left  = audioBuffer.getChannelData(0);
  const right  = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
  const total  = left.length;

  return {
    extract(target, numFrames, position) {
      let count = 0;
      for (let i = 0; i < numFrames; i++) {
        let idx = position + i;
        if (looping) {
          idx = idx % total;
        } else if (idx >= total) {
          break;
        }
        target[i * 2]     = left[idx];
        target[i * 2 + 1] = right[idx];
        count++;
      }
      return count;
    },
  };
}
