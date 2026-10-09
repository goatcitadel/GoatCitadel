import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { Button } from "../../ui/Button";
export type ChatMediaProps = Pick<MissionThreadedActiveSessionSurfaceProps,
  "draft" | "historicalReadOnly" | "sending" | "sessionControlBanner" | "voiceBusy" | "voiceTalkActive" | "voiceInputAvailable" | "voiceOutputAvailable" |
  "voiceUnavailableReason" | "voiceStatusLabel" | "onToggleVoiceTalk" | "onOpenAudioTranscribe" | "onAudioFileSelected" | "audioInputRef" |
  "speakResponsesEnabled" | "onToggleSpeakResponses" | "imageBusy" | "imageGenerationAvailable" | "imageEditAvailable" | "onGenerateImage" | "onEditImage" |
  "liveVoiceActive" | "liveVoiceAvailable" | "liveVoiceUnavailableReason" | "onToggleLiveVoice">;
export function ChatMediaControls({ props }: { props: ChatMediaProps }) {
  const disabled = props.historicalReadOnly || Boolean(props.sessionControlBanner) || props.sending;
  return <details className="mt-1 text-xs text-fg-secondary"><summary className="cursor-pointer text-accent">Voice and images</summary>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button size="sm" className="h-auto min-h-8 py-1 max-sm:min-h-11" disabled={disabled || !props.liveVoiceAvailable || (props.voiceBusy && !props.liveVoiceActive)} onClick={props.onToggleLiveVoice}>{props.liveVoiceActive ? "Stop live voice" : "Live voice"}</Button>
      <Button size="sm" className="h-auto min-h-8 py-1 max-sm:min-h-11" disabled={disabled || !props.voiceInputAvailable || props.voiceBusy} onClick={props.onToggleVoiceTalk}>{props.voiceTalkActive ? "Stop push-to-talk" : "Push-to-talk"}</Button>
      <Button size="sm" className="h-auto min-h-8 py-1 max-sm:min-h-11" disabled={disabled || !props.voiceInputAvailable || props.voiceBusy} onClick={props.onOpenAudioTranscribe}>Transcribe audio</Button>
      <Button size="sm" className="h-auto min-h-8 py-1 max-sm:min-h-11" disabled={disabled || !props.voiceOutputAvailable} onClick={props.onToggleSpeakResponses}>{props.speakResponsesEnabled ? "Stop speaking replies" : "Speak replies"}</Button>
      <Button size="sm" className="h-auto min-h-8 py-1 max-sm:min-h-11" disabled={disabled || !props.imageGenerationAvailable || props.imageBusy || !props.draft.trim()} onClick={props.onGenerateImage}>{props.imageBusy ? "Creating image…" : "Create image"}</Button>
      {props.imageEditAvailable ? <Button size="sm" className="h-auto min-h-8 py-1 max-sm:min-h-11" disabled={disabled || props.imageBusy || !props.draft.trim()} onClick={props.onEditImage}>Edit image</Button> : null}
    </div>
    <p>{props.voiceStatusLabel ?? props.voiceUnavailableReason ?? (!props.voiceInputAvailable ? "Voice input is unavailable for the selected route or host." : "")}</p>
    {!props.liveVoiceAvailable ? <p>{props.liveVoiceUnavailableReason ?? "Live voice is unavailable for the selected route or host."}</p> : null}
    {!props.imageGenerationAvailable ? <p>Image generation is unavailable for the selected route.</p> : null}
    <input ref={props.audioInputRef} type="file" accept="audio/*" aria-label="Attach audio" className="sr-only" tabIndex={-1} disabled={disabled}
      onChange={(event) => { props.onAudioFileSelected?.(event.target.files); event.target.value = ""; }} />
  </details>;
}
