import { describe, expect, it, vi } from "vitest";
import {
  buildChannelVoiceReplyAttachment,
  readChannelVoiceReplyMode,
  shouldSynthesizeVoiceReply,
  VOICE_REPLY_ATTACHMENT_TITLE,
  type ChannelVoiceReplyDeps,
} from "./channel-voice-reply-service.js";

function createDeps(overrides: Partial<ChannelVoiceReplyDeps> = {}) {
  const synthesizeSpeech = vi.fn(async () => ({
    bytesBase64: Buffer.from("OggSvoice").toString("base64"),
    mimeType: "audio/ogg",
  }));
  const recordDevDiagnostic = vi.fn();
  const deps: ChannelVoiceReplyDeps = {
    isChannelVoiceReplyEnabled: () => true,
    synthesizeSpeech,
    recordDevDiagnostic,
    ...overrides,
  };
  return { deps, synthesizeSpeech, recordDevDiagnostic };
}

describe("readChannelVoiceReplyMode", () => {
  it("defaults to off for missing or malformed config values", () => {
    expect(readChannelVoiceReplyMode({})).toBe("off");
    expect(readChannelVoiceReplyMode({ voiceReplyMode: "nonsense" })).toBe("off");
    expect(readChannelVoiceReplyMode({ voiceReplyMode: 42 })).toBe("off");
    expect(readChannelVoiceReplyMode({ voiceReplyMode: "always" })).toBe("always");
    expect(readChannelVoiceReplyMode({ voiceReplyMode: "voice_on_voice" })).toBe("voice_on_voice");
  });
});

describe("shouldSynthesizeVoiceReply", () => {
  it("covers the mode matrix", () => {
    expect(shouldSynthesizeVoiceReply({ mode: "off" })).toBe(false);
    expect(shouldSynthesizeVoiceReply({ mode: "always" })).toBe(true);
    // voice_on_voice is strict: an unreported marker (undefined) degrades to
    // text-only rather than synthesizing.
    expect(shouldSynthesizeVoiceReply({ mode: "voice_on_voice" })).toBe(false);
    expect(shouldSynthesizeVoiceReply({ mode: "voice_on_voice", wasVoiceInbound: true })).toBe(true);
    expect(shouldSynthesizeVoiceReply({ mode: "voice_on_voice", wasVoiceInbound: false })).toBe(false);
  });
});

describe("buildChannelVoiceReplyAttachment", () => {
  it("never synthesizes when the feature flag is off", async () => {
    const { deps, synthesizeSpeech } = createDeps({ isChannelVoiceReplyEnabled: () => false });
    const attachment = await buildChannelVoiceReplyAttachment(
      { text: "hello", channelKey: "telegram", connectionConfig: { voiceReplyMode: "always" } },
      deps,
    );
    expect(attachment).toBeUndefined();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("returns no audio when the connection mode is off (the default)", async () => {
    const { deps, synthesizeSpeech } = createDeps();
    const attachment = await buildChannelVoiceReplyAttachment(
      { text: "hello", channelKey: "telegram", connectionConfig: {} },
      deps,
    );
    expect(attachment).toBeUndefined();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("attaches inline ogg audio when mode is always on a supported channel", async () => {
    const { deps, synthesizeSpeech } = createDeps();
    const attachment = await buildChannelVoiceReplyAttachment(
      { text: "hello", channelKey: "telegram", connectionConfig: { voiceReplyMode: "always" } },
      deps,
    );
    expect(synthesizeSpeech).toHaveBeenCalledWith({ text: "hello" });
    expect(attachment).toEqual({
      title: VOICE_REPLY_ATTACHMENT_TITLE,
      mimeType: "audio/ogg",
      dataBase64: Buffer.from("OggSvoice").toString("base64"),
    });
  });

  it("honors voice_on_voice: no audio for a text inbound, audio for a voice inbound (3.6)", async () => {
    const textInbound = createDeps();
    expect(
      await buildChannelVoiceReplyAttachment(
        {
          text: "hello",
          channelKey: "telegram",
          connectionConfig: { voiceReplyMode: "voice_on_voice" },
          wasVoiceInbound: false,
        },
        textInbound.deps,
      ),
    ).toBeUndefined();
    expect(textInbound.synthesizeSpeech).not.toHaveBeenCalled();

    const voiceInbound = createDeps();
    const attachment = await buildChannelVoiceReplyAttachment(
      {
        text: "hello",
        channelKey: "telegram",
        connectionConfig: { voiceReplyMode: "voice_on_voice" },
        wasVoiceInbound: true,
      },
      voiceInbound.deps,
    );
    expect(voiceInbound.synthesizeSpeech).toHaveBeenCalledWith({ text: "hello" });
    expect(attachment).toMatchObject({ mimeType: "audio/ogg" });
  });

  it("skips unsupported channels without synthesizing and records a diagnostic", async () => {
    const { deps, synthesizeSpeech, recordDevDiagnostic } = createDeps();
    for (const channelKey of ["slack", "discord", "whatsapp", "ntfy", "teams"]) {
      const attachment = await buildChannelVoiceReplyAttachment(
        { text: "hello", channelKey, connectionConfig: { voiceReplyMode: "always" } },
        deps,
      );
      expect(attachment, channelKey).toBeUndefined();
    }
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "voice.reply.skipped_channel", level: "debug" }),
    );
  });

  it("degrades to text-only with a warn diagnostic when synthesis fails", async () => {
    const { deps, recordDevDiagnostic } = createDeps({
      synthesizeSpeech: vi.fn(async () => {
        throw new Error("piper exploded");
      }),
    });
    const attachment = await buildChannelVoiceReplyAttachment(
      { text: "hello", channelKey: "telegram", connectionConfig: { voiceReplyMode: "always" } },
      deps,
    );
    expect(attachment).toBeUndefined();
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "voice.reply.synthesis_failed",
        level: "warn",
        context: expect.objectContaining({ error: "piper exploded" }),
      }),
    );
  });

  it("degrades to text-only when synthesis exceeds the reply-path budget", async () => {
    vi.useFakeTimers();
    try {
      const { deps, recordDevDiagnostic } = createDeps({
        synthesizeSpeech: vi.fn(() => new Promise(() => {})),
      });
      const pending = buildChannelVoiceReplyAttachment(
        { text: "hello", channelKey: "telegram", connectionConfig: { voiceReplyMode: "always" } },
        deps,
      );
      await vi.advanceTimersByTimeAsync(15_001);
      const attachment = await pending;
      expect(attachment).toBeUndefined();
      expect(recordDevDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "voice.reply.synthesis_failed",
          context: expect.objectContaining({ error: expect.stringContaining("reply-path budget") }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns no audio for empty reply text", async () => {
    const { deps, synthesizeSpeech } = createDeps();
    const attachment = await buildChannelVoiceReplyAttachment(
      { text: "   ", channelKey: "telegram", connectionConfig: { voiceReplyMode: "always" } },
      deps,
    );
    expect(attachment).toBeUndefined();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("skips voice_on_voice replies when the inbound message is explicitly non-voice", async () => {
    const { deps, synthesizeSpeech } = createDeps();
    const attachment = await buildChannelVoiceReplyAttachment(
      {
        text: "hello",
        channelKey: "telegram",
        connectionConfig: { voiceReplyMode: "voice_on_voice" },
        wasVoiceInbound: false,
      },
      deps,
    );
    expect(attachment).toBeUndefined();
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("attaches voice_on_voice replies when the inbound message is marked as voice", async () => {
    const { deps, synthesizeSpeech } = createDeps();
    const attachment = await buildChannelVoiceReplyAttachment(
      {
        text: "hello",
        channelKey: "telegram",
        connectionConfig: { voiceReplyMode: "voice_on_voice" },
        wasVoiceInbound: true,
      },
      deps,
    );
    expect(synthesizeSpeech).toHaveBeenCalledWith({ text: "hello" });
    expect(attachment).toEqual({
      title: VOICE_REPLY_ATTACHMENT_TITLE,
      mimeType: "audio/ogg",
      dataBase64: Buffer.from("OggSvoice").toString("base64"),
    });
  });
});
