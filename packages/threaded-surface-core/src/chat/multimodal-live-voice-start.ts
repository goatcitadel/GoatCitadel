import { createRealtimeVoiceClientSecret } from "@goatcitadel/mission-control-shared/api/client";

type LiveVoiceUiState =
  | "idle"
  | "requesting_mic"
  | "connecting"
  | "listening"
  | "speaking"
  | "thinking"
  | "stopping"
  | "error";

interface LiveVoiceConnection {
  peerConnection: RTCPeerConnection;
  dataChannel: RTCDataChannel;
  mediaStream: MediaStream;
  audioElement: HTMLAudioElement;
  voiceSessionId: string;
}

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

function mapRealtimeEventToLiveVoiceState(eventType: string): LiveVoiceUiState | null {
  if (
    eventType === "response.audio.delta" ||
    eventType === "response.output_audio.delta" ||
    eventType === "output_audio_buffer.started"
  ) {
    return "speaking";
  }
  if (
    eventType === "input_audio_buffer.speech_stopped" ||
    eventType === "response.created" ||
    eventType === "response.output_item.added"
  ) {
    return "thinking";
  }
  if (
    eventType === "input_audio_buffer.speech_started" ||
    eventType === "response.done" ||
    eventType === "output_audio_buffer.stopped"
  ) {
    return "listening";
  }
  if (eventType === "error") {
    return "error";
  }
  return null;
}

function parseRealtimeEventType(raw: MessageEvent["data"]): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : null;
  } catch {
    return null;
  }
}

/** First-use browser work only; the hook retains cancellation and resource custody. */
export async function startBrowserRealtimeVoice(input: {
  sessionId: string | null;
  abortIfCanceled: () => void;
  setLiveVoiceState: (state: LiveVoiceUiState) => void;
  onVoiceSessionCreated: (sessionId: string) => void;
  onMediaStreamCreated: (stream: MediaStream) => void;
  onConnectionCreated: (connection: LiveVoiceConnection) => void;
}): Promise<void> {
  input.abortIfCanceled();
  const token = await createRealtimeVoiceClientSecret({
    surface: "chat",
    sessionId: input.sessionId ?? undefined,
  });
  input.onVoiceSessionCreated(token.voiceSessionId);
  input.abortIfCanceled();
  input.setLiveVoiceState("requesting_mic");
  const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  input.onMediaStreamCreated(mediaStream);
  input.abortIfCanceled();
  input.setLiveVoiceState("connecting");

  let peerConnection: RTCPeerConnection | null = null;
  let audioElement: HTMLAudioElement | null = null;
  let dataChannel: RTCDataChannel | null = null;
  try {
    peerConnection = new window.RTCPeerConnection();
    audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    audioElement.setAttribute("data-goatcitadel-live-voice", "true");
    document.body?.appendChild(audioElement);

    peerConnection.ontrack = (event) => {
      audioElement!.srcObject = event.streams[0] ?? null;
    };
    for (const track of mediaStream.getAudioTracks()) {
      peerConnection.addTrack(track, mediaStream);
    }
    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.onopen = () => input.setLiveVoiceState("listening");
    dataChannel.onmessage = (event) => {
      const eventType = parseRealtimeEventType(event.data);
      const nextState = eventType ? mapRealtimeEventToLiveVoiceState(eventType) : null;
      if (nextState) {
        input.setLiveVoiceState(nextState);
      }
    };
    dataChannel.onerror = () => input.setLiveVoiceState("error");

    const connection: LiveVoiceConnection = {
      peerConnection,
      dataChannel,
      mediaStream,
      audioElement,
      voiceSessionId: token.voiceSessionId,
    };
    input.onConnectionCreated(connection);
  } catch (error) {
    // Until handoff, only this helper can retire partially allocated resources.
    // The hook already owns the microphone and issued session. Preserve the
    // startup error even if a platform cleanup operation also fails.
    for (const retire of [
      () => dataChannel?.close(),
      () => peerConnection?.close(),
      () => {
        if (audioElement) audioElement.srcObject = null;
      },
      () => audioElement?.remove(),
    ]) {
      try {
        retire();
      } catch {
        /* Continue retiring the other owned resources. */
      }
    }
    throw error;
  }
  input.abortIfCanceled();

  const offer = await peerConnection!.createOffer();
  if (!offer.sdp) {
    throw new Error("Unable to create a WebRTC offer for OpenAI Realtime voice.");
  }
  await peerConnection!.setLocalDescription(offer);
  input.abortIfCanceled();
  const sdpResponse = await fetch(OPENAI_REALTIME_CALLS_URL, {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${token.clientSecret.value}`,
      "Content-Type": "application/sdp",
    },
  });
  if (!sdpResponse.ok) {
    const message = (await sdpResponse.text()).trim() || sdpResponse.statusText || "Realtime connection failed.";
    throw new Error(`OpenAI Realtime WebRTC connection failed (${sdpResponse.status}): ${message}`);
  }
  input.abortIfCanceled();
  await peerConnection!.setRemoteDescription({
    type: "answer",
    sdp: await sdpResponse.text(),
  });
  input.abortIfCanceled();
  input.setLiveVoiceState("listening");
}
