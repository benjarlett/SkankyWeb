import { getFile } from './db.js';

// Tone is loaded globally from CDN
let tonePlayer = null;
let pitchShift = null;
let toneStarted = false;

export let currentLoopId = null;
export let isPlaying = false;

async function ensureToneStarted() {
  if (!toneStarted) {
    await Tone.start();
    toneStarted = true;
  }
}

export async function play(loopId, filename, loopData) {
  await stop();

  const blob = await getFile(filename);
  if (!blob) {
    console.error('Audio file not found in IndexedDB:', filename);
    return false;
  }

  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await Tone.context.decodeAudioData(arrayBuffer);

  pitchShift = new Tone.PitchShift(
    loopData.transposeSemitones + loopData.tuneCents / 100
  ).toDestination();

  tonePlayer = new Tone.Player(audioBuffer).connect(pitchShift);
  tonePlayer.loop = loopData.looping;

  await ensureToneStarted();
  tonePlayer.start();

  currentLoopId = loopId;
  isPlaying = true;

  // Auto-clear state when single-play finishes
  if (!loopData.looping) {
    const durationMs = audioBuffer.duration * 1000;
    setTimeout(() => {
      if (currentLoopId === loopId) {
        currentLoopId = null;
        isPlaying = false;
        document.dispatchEvent(new CustomEvent('playbackEnded', { detail: { loopId } }));
      }
    }, durationMs + 200);
  }

  return true;
}

export async function stop() {
  if (tonePlayer) {
    try { tonePlayer.stop(); } catch (_) {}
    tonePlayer.dispose();
    tonePlayer = null;
  }
  if (pitchShift) {
    pitchShift.dispose();
    pitchShift = null;
  }
  currentLoopId = null;
  isPlaying = false;
}

export function updatePitch(semitones, cents) {
  if (pitchShift) {
    pitchShift.pitch = semitones + cents / 100;
  }
}
