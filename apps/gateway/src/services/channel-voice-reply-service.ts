import type { ChannelAttachmentInput } from "@goatcitadel/contracts";
import { planChannelRichMessageDelivery } from "@goatcitadel/gateway-core";

/**
 * Channel voice replies (Competitive-gap program phase B2b).
 *
 * Given an assistant reply that is about to be delivered to a channel, decide
 * whether to additionally synthesize a TTS voice note and return it as an
 * inline audio attachment for the EXISTING outbound attachment lane
 * (`resolveChannelSendAttachments` + the rich-message planner in
 * `packages/gateway-core/src/channel-core.ts`). No new send transport exists:
 * the attachment rides the same `channel.send` invocation as the text.
 *
 * Invariants:
 * - The text reply is ALWAYS sent regardless of what happens here — audio is
 *   additive (accessibility + evidence). This module never throws; every
 *   failure path resolves to `undefined` plus a dev diagnostic.
 * - Gated behind the default-off `channelVoiceReplyV1Enabled` feature flag
 *   AND a per-connection `voiceReplyMode` preference (default "off"), so
 *   default behavior is byte-identical to today.
 *
 * Governance posture: TTS renders only the already-policy-gated assistant
 * reply. The text passed here has already cleared the outbound sanitizer and
 * tool-policy gates, so no additional content scanning is performed — adding
 * one would create a second, divergent policy surface.
 */

export type ChannelVoiceReplyMode = "off" | "voice_on_voice" | "always";

/**
 * Channels that accept inline audio as a native voice-style attachment in v1.
 * Other channels either lack an inline-audio lane or degrade audio to a
 * document/text fallback in their rich-message profile, which defeats the
 * purpose of a voice note.
 */
export const VOICE_REPLY_SUPPORTED_CHANNELS: ReadonlySet<string> = new Set(["telegram"]);

/**
 * Hard ceiling on how long the reply path waits for synthesis. The reply
 * delivery is sequential (synthesize first, then send text+audio together),
 * so a hung synthesis must never delay the text reply beyond this bound.
 */
export const VOICE_REPLY_SYNTH_TIMEOUT_MS = 15_000;

export const VOICE_REPLY_ATTACHMENT_TITLE = "voice-reply.ogg";

interface VoiceReplyDiagnosticInput {
  level: "debug" | "info" | "warn" | "error";
  category: string;
  event: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface ChannelVoiceReplyDeps {
  isChannelVoiceReplyEnabled: () => boolean;
  synthesizeSpeech: (input: { text: string }) => Promise<{ bytesBase64: string; mimeType: string }>;
  recordDevDiagnostic?: (input: VoiceReplyDiagnosticInput) => void;
}

export interface ChannelVoiceReplyInput {
  /** Already-policy-gated assistant reply text about to be delivered. */
  text: string;
  /** Normalized channel key, e.g. "telegram". */
  channelKey: string;
  /** Connection config carrying the per-connection `voiceReplyMode` field. */
  connectionConfig: Record<string, unknown>;
  connectionId?: string;
  /**
   * Whether the inbound message that triggered this reply was a voice
   * message. Not yet threaded on this branch — see the PR #175 note in
   * `shouldSynthesizeVoiceReply`.
   */
  wasVoiceInbound?: boolean;
}

export function readChannelVoiceReplyMode(config: Record<string, unknown>): ChannelVoiceReplyMode {
  const raw = config.voiceReplyMode;
  if (raw === "voice_on_voice" || raw === "always") {
    return raw;
  }
  return "off";
}

export function shouldSynthesizeVoiceReply(input: { mode: ChannelVoiceReplyMode; wasVoiceInbound?: boolean }): boolean {
  if (input.mode === "off") {
    return false;
  }
  if (input.mode === "always") {
    return true;
  }
  // mode === "voice_on_voice": synthesize only when the inbound message that
  // triggered this reply was itself voice. The reply path (gateway-service
  // `maybeBuildChannelVoiceReplyAttachment`) now threads `wasVoiceInbound`, derived
  // from the `[voice transcript — untrusted, auto-transcribed]` content framing.
  // An `undefined` marker (a caller that does not report inbound modality) still
  // defaults to synthesize, preserving behavior for any path that omits it.
  return input.wasVoiceInbound !== false;
}

function channelAcceptsNativeInlineAudio(channelKey: string, mimeType: string): boolean {
  const normalizedKey = channelKey.toLowerCase();
  if (!VOICE_REPLY_SUPPORTED_CHANNELS.has(normalizedKey)) {
    return false;
  }
  const plan = planChannelRichMessageDelivery(normalizedKey, {
    attachments: [{ mimeType, title: VOICE_REPLY_ATTACHMENT_TITLE, dataBase64: "AA==" }],
  });
  return plan?.attachments[0]?.disposition === "native_media";
}

async function synthesizeWithHardTimeout(
  deps: ChannelVoiceReplyDeps,
  text: string,
): Promise<{ bytesBase64: string; mimeType: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      deps.synthesizeSpeech({ text }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Voice reply synthesis exceeded the ${VOICE_REPLY_SYNTH_TIMEOUT_MS}ms reply-path budget.`));
        }, VOICE_REPLY_SYNTH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Returns an inline audio `ChannelAttachmentInput` when a voice reply should
 * accompany the text reply, or `undefined` when voice is disabled, the
 * channel cannot deliver native inline audio, or synthesis fails. Never
 * throws.
 */
export async function buildChannelVoiceReplyAttachment(
  input: ChannelVoiceReplyInput,
  deps: ChannelVoiceReplyDeps,
): Promise<ChannelAttachmentInput | undefined> {
  try {
    if (!deps.isChannelVoiceReplyEnabled()) {
      return undefined;
    }
    const text = input.text?.trim();
    if (!text) {
      return undefined;
    }
    const mode = readChannelVoiceReplyMode(input.connectionConfig ?? {});
    if (!shouldSynthesizeVoiceReply({ mode, wasVoiceInbound: input.wasVoiceInbound })) {
      return undefined;
    }
    if (!channelAcceptsNativeInlineAudio(input.channelKey, "audio/ogg")) {
      deps.recordDevDiagnostic?.({
        level: "debug",
        category: "voice",
        event: "voice.reply.skipped_channel",
        message: "Voice reply skipped: channel does not deliver native inline audio.",
        context: { channelKey: input.channelKey, connectionId: input.connectionId },
      });
      return undefined;
    }

    const synthesized = await synthesizeWithHardTimeout(deps, text);
    return {
      title: VOICE_REPLY_ATTACHMENT_TITLE,
      mimeType: synthesized.mimeType,
      dataBase64: synthesized.bytesBase64,
    };
  } catch (error) {
    deps.recordDevDiagnostic?.({
      level: "warn",
      category: "voice",
      event: "voice.reply.synthesis_failed",
      message: "Voice reply synthesis failed; delivering text-only reply.",
      context: {
        channelKey: input.channelKey,
        connectionId: input.connectionId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}
