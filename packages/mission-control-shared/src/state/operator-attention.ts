export type OperatorAttentionSoundCue =
  | "blocked"
  | "connected"
  | "critical"
  | "disconnected"
  | "done"
  | "handoff_ready"
  | "message"
  | "muted_tick"
  | "problem"
  | "resumed"
  | "saved"
  | "soft_update"
  | "started"
  | "waiting";
export type OperatorAttentionSoundMode = "off" | "subtle" | "normal";

type AudioContextConstructor = typeof AudioContext;
type AudioConstructor = typeof Audio;

const SOUND_ASSET_URLS: Record<OperatorAttentionSoundCue, string> = {
  blocked: "/assets/sounds/blocked.wav",
  connected: "/assets/sounds/connected.wav",
  critical: "/assets/sounds/critical.wav",
  disconnected: "/assets/sounds/disconnected.wav",
  done: "/assets/sounds/done.wav",
  handoff_ready: "/assets/sounds/handoff_ready.wav",
  message: "/assets/sounds/message.wav",
  muted_tick: "/assets/sounds/muted_tick.wav",
  problem: "/assets/sounds/problem.wav",
  resumed: "/assets/sounds/resumed.wav",
  saved: "/assets/sounds/saved.wav",
  soft_update: "/assets/sounds/soft_update.wav",
  started: "/assets/sounds/started.wav",
  waiting: "/assets/sounds/waiting.wav",
};

const SOUND_PATTERNS: Record<
  OperatorAttentionSoundCue,
  Array<{ frequency: number; startMs: number; durationMs: number }>
> = {
  blocked: [
    { frequency: 410, startMs: 0, durationMs: 115 },
    { frequency: 360, startMs: 130, durationMs: 150 },
  ],
  connected: [{ frequency: 880, startMs: 0, durationMs: 95 }],
  critical: [
    { frequency: 330, startMs: 0, durationMs: 115 },
    { frequency: 294, startMs: 135, durationMs: 115 },
    { frequency: 262, startMs: 270, durationMs: 160 },
  ],
  disconnected: [{ frequency: 330, startMs: 0, durationMs: 140 }],
  done: [
    { frequency: 660, startMs: 0, durationMs: 110 },
    { frequency: 880, startMs: 120, durationMs: 150 },
  ],
  handoff_ready: [
    { frequency: 587, startMs: 0, durationMs: 95 },
    { frequency: 784, startMs: 105, durationMs: 145 },
  ],
  message: [{ frequency: 660, startMs: 0, durationMs: 100 }],
  muted_tick: [{ frequency: 520, startMs: 0, durationMs: 55 }],
  waiting: [
    { frequency: 520, startMs: 0, durationMs: 120 },
    { frequency: 740, startMs: 140, durationMs: 130 },
  ],
  problem: [
    { frequency: 392, startMs: 0, durationMs: 140 },
    { frequency: 294, startMs: 155, durationMs: 190 },
  ],
  resumed: [
    { frequency: 494, startMs: 0, durationMs: 90 },
    { frequency: 659, startMs: 100, durationMs: 130 },
  ],
  saved: [{ frequency: 784, startMs: 0, durationMs: 95 }],
  soft_update: [{ frequency: 740, startMs: 0, durationMs: 95 }],
  started: [
    { frequency: 440, startMs: 0, durationMs: 80 },
    { frequency: 587, startMs: 90, durationMs: 130 },
  ],
};

export async function playOperatorAttentionSound(
  cue: OperatorAttentionSoundCue | undefined,
  mode: OperatorAttentionSoundMode,
): Promise<boolean> {
  if (!cue || mode === "off" || typeof window === "undefined") {
    return false;
  }

  if (await playSoundAsset(cue, mode)) {
    return true;
  }
  return playSynthFallback(cue, mode);
}

async function playSoundAsset(cue: OperatorAttentionSoundCue, mode: OperatorAttentionSoundMode): Promise<boolean> {
  const AudioCtor = getAudioConstructor();
  if (!AudioCtor) {
    return false;
  }
  try {
    const audio = new AudioCtor(SOUND_ASSET_URLS[cue]);
    audio.preload = "auto";
    audio.volume = mode === "normal" ? 0.85 : 0.48;
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

async function playSynthFallback(cue: OperatorAttentionSoundCue, mode: OperatorAttentionSoundMode): Promise<boolean> {
  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) {
    return false;
  }

  try {
    const context = new AudioContextCtor();
    if (context.state === "suspended") {
      await context.resume();
    }
    const volume = mode === "normal" ? 0.09 : 0.045;
    const now = context.currentTime;
    for (const note of SOUND_PATTERNS[cue]) {
      playNote(context, now + note.startMs / 1000, note.frequency, note.durationMs / 1000, volume);
    }
    window.setTimeout(() => void context.close(), 900);
    return true;
  } catch {
    return false;
  }
}

function getAudioConstructor(): AudioConstructor | undefined {
  const audioWindow = window as Window &
    typeof globalThis & {
      Audio?: AudioConstructor;
    };
  return audioWindow.Audio;
}

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  const audioWindow = window as Window &
    typeof globalThis & {
      webkitAudioContext?: AudioContextConstructor;
    };
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
}

function playNote(
  context: AudioContext,
  startTime: number,
  frequency: number,
  durationSeconds: number,
  volume: number,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startTime);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(volume, startTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSeconds);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + durationSeconds + 0.02);
}
