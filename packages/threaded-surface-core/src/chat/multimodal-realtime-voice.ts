import { stopRealtimeVoiceSession } from "@goatcitadel/mission-control-shared/api/client";
import { startBrowserRealtimeVoice, type LiveVoiceConnection, type LiveVoiceUiState } from "./multimodal-live-voice-start.js";

type RealtimeVoiceInput = {
  sessionId: string | null;
  isStartCurrent: () => boolean;
  isAuthorityCurrent: () => boolean;
  setState: (state: LiveVoiceUiState) => void;
};

/** Owns a single explicit voice action. Resources acquired after cancellation are retired by start. */
export function createRealtimeVoiceOperation(input: RealtimeVoiceInput) {
  let stopped = false;
  let stream: MediaStream | undefined;
  let connection: LiveVoiceConnection | undefined;
  let voiceSessionId: string | undefined;
  let sessionRetired = false;

  function disposeLocalResources() {
    const ownedConnection = connection;
    const ownedStream = stream;
    connection = undefined;
    stream = undefined;
    for (const dispose of [
      () => ownedConnection?.dataChannel.close(),
      () => ownedConnection?.peerConnection.close(),
      ...(ownedStream?.getTracks() ?? []).map((track) => () => track.stop()),
      () => {
        if (ownedConnection) ownedConnection.audioElement.srcObject = null;
      },
      () => ownedConnection?.audioElement.remove(),
    ]) {
      try {
        dispose();
      } catch {
        // Continue cleanup of the other owned resources if one device or browser operation fails.
      }
    }
  }

  async function stop() {
    stopped = true;
    disposeLocalResources();
    if (!voiceSessionId || sessionRetired || !input.isAuthorityCurrent()) return;
    sessionRetired = true;
    await stopRealtimeVoiceSession(voiceSessionId);
  }

  function abortIfCanceled() {
    if (stopped || !input.isStartCurrent()) {
      throw new DOMException("OpenAI Realtime voice start was canceled.", "AbortError");
    }
  }

  async function start() {
    try {
      await startBrowserRealtimeVoice({
        sessionId: input.sessionId,
        abortIfCanceled,
        setLiveVoiceState: (state) => {
          if (!stopped && input.isAuthorityCurrent()) input.setState(state);
        },
        onVoiceSessionCreated: (id) => { voiceSessionId = id; },
        onMediaStreamCreated: (mediaStream) => { stream = mediaStream; },
        onConnectionCreated: (liveConnection) => { connection = liveConnection; },
      });
      abortIfCanceled();
    } catch (error) {
      await stop().catch(() => undefined);
      throw error;
    }
  }

  function setMuted(muted: boolean): boolean {
    if (!connection || stopped || !input.isAuthorityCurrent()) return false;
    for (const track of connection.mediaStream.getAudioTracks()) track.enabled = !muted;
    return true;
  }

  return { start, stop, setMuted };
}
