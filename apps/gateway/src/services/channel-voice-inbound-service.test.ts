import { describe, expect, it, vi } from "vitest";
import {
  ChannelVoiceInboundService,
  MAX_CHANNEL_VOICE_MEDIA_BYTES,
  isAllowedWhatsAppMediaUrl,
  type ChannelVoiceInboundDeps,
} from "./channel-voice-inbound-service.js";

// Security posture regression coverage (mirrors media-voice-service.sniff.security.test.ts
// for the byte-sniff layer): provider media URLs are SSRF-gated, downloads are
// size-capped, and downloaded bytes are sniffed before any transcription runs.

const OGG_BYTES = Buffer.concat([Buffer.from([0x4f, 0x67, 0x67, 0x53]), Buffer.alloc(64)]);
const ZIP_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(bytes: Buffer, status = 200): Response {
  return new Response(new Uint8Array(bytes), { status });
}

function createService(overrides: Partial<ChannelVoiceInboundDeps> = {}) {
  const fetchWithTimeout = vi.fn<ChannelVoiceInboundDeps["fetchWithTimeout"]>(async () => {
    throw new Error("unexpected fetch");
  });
  const transcribeVoice = vi.fn(async () => ({ text: "hello from voice" }));
  const deps: ChannelVoiceInboundDeps = {
    fetchWithTimeout,
    transcribeVoice,
    isConnectionUrlAllowlisted: () => true,
    resolveConnectionSecret: (config, directKey) => {
      const value = config[directKey];
      return typeof value === "string" && value.trim() ? value : undefined;
    },
    ...overrides,
  };
  return { service: new ChannelVoiceInboundService(deps), fetchWithTimeout, transcribeVoice, deps };
}

describe("ChannelVoiceInboundService — telegram", () => {
  it("downloads via getFile then transcribes (happy path)", async () => {
    const { service, fetchWithTimeout, transcribeVoice } = createService();
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "voice/file_7.oga", file_size: 2048 } }))
      .mockResolvedValueOnce(bytesResponse(OGG_BYTES));

    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "AwACAgIAAxkBAAIB",
      mimeType: "audio/ogg",
    });

    expect(result).toEqual({ ok: true, transcript: "hello from voice" });
    expect(fetchWithTimeout).toHaveBeenNthCalledWith(
      1,
      "https://api.telegram.org/bot123456:bot-secret/getFile?file_id=AwACAgIAAxkBAAIB",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetchWithTimeout).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.org/file/bot123456:bot-secret/voice/file_7.oga",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(transcribeVoice).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "audio/ogg", bytesBase64: OGG_BYTES.toString("base64") }),
    );
  });

  it("fails typed without any network call when the bot token is missing", async () => {
    const { service, fetchWithTimeout, transcribeVoice } = createService();
    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: {},
      fileId: "AwACAgIAAxkBAAIB",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "missing_credentials" }));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(transcribeVoice).not.toHaveBeenCalled();
  });

  it("rejects malformed file ids before constructing a URL", async () => {
    const { service, fetchWithTimeout } = createService();
    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "../../etc/passwd",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "invalid_media_reference" }));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("rejects an unsafe getFile file_path without downloading it", async () => {
    const { service, fetchWithTimeout } = createService();
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "voice/../../secrets" } }));
    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "AwACAgIAAxkBAAIB",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "invalid_media_reference" }));
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("fails typed when the outbound allowlist rejects the Telegram host", async () => {
    const { service, fetchWithTimeout } = createService({ isConnectionUrlAllowlisted: () => false });
    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "AwACAgIAAxkBAAIB",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "url_not_allowlisted" }));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("refuses oversized media declared by getFile before downloading", async () => {
    const { service, fetchWithTimeout } = createService();
    fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        result: { file_path: "voice/file_7.oga", file_size: MAX_CHANNEL_VOICE_MEDIA_BYTES + 1 },
      }),
    );
    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "AwACAgIAAxkBAAIB",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "media_too_large" }));
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("caps the actual download size even when metadata omitted file_size", async () => {
    const { service, fetchWithTimeout, transcribeVoice } = createService();
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "voice/file_7.oga" } }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { "content-length": String(MAX_CHANNEL_VOICE_MEDIA_BYTES + 1) },
        }),
      );
    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "AwACAgIAAxkBAAIB",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "media_too_large" }));
    expect(transcribeVoice).not.toHaveBeenCalled();
  });
});

describe("ChannelVoiceInboundService — whatsapp", () => {
  const config = { accessToken: "whatsapp-access-token" };

  it("looks up media metadata then downloads the Meta CDN URL (happy path)", async () => {
    const { service, fetchWithTimeout, transcribeVoice } = createService();
    fetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({
          url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media-id-9000",
          mime_type: "audio/ogg",
          file_size: 4096,
          id: "media-id-9000",
        }),
      )
      .mockResolvedValueOnce(bytesResponse(OGG_BYTES));

    const result = await service.transcribe({
      channel: "whatsapp",
      connectionConfig: config,
      mediaId: "media-id-9000",
    });

    expect(result).toEqual({ ok: true, transcript: "hello from voice" });
    expect(fetchWithTimeout).toHaveBeenNthCalledWith(
      1,
      "https://graph.facebook.com/v23.0/media-id-9000",
      expect.objectContaining({
        redirect: "error",
        headers: { Authorization: "Bearer whatsapp-access-token" },
      }),
    );
    expect(fetchWithTimeout).toHaveBeenNthCalledWith(
      2,
      "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media-id-9000",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(transcribeVoice).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "audio/ogg" }));
  });

  it("SSRF gate: refuses a returned media URL on a non-Meta host and never fetches it", async () => {
    const { service, fetchWithTimeout, transcribeVoice } = createService();
    fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({ url: "https://attacker.example.com/steal-bearer-token", mime_type: "audio/ogg" }),
    );

    const result = await service.transcribe({
      channel: "whatsapp",
      connectionConfig: config,
      mediaId: "media-id-9000",
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "url_not_allowlisted" }));
    // Only the graph.facebook.com metadata call happened; the attacker URL was never fetched.
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(transcribeVoice).not.toHaveBeenCalled();
  });

  it("SSRF gate: refuses non-https Meta-lookalike URLs", async () => {
    const { service, fetchWithTimeout } = createService();
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse({ url: "http://graph.facebook.com.evil.io/media" }));
    const result = await service.transcribe({
      channel: "whatsapp",
      connectionConfig: config,
      mediaId: "media-id-9000",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "url_not_allowlisted" }));
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed media ids before constructing a URL", async () => {
    const { service, fetchWithTimeout } = createService();
    const result = await service.transcribe({
      channel: "whatsapp",
      connectionConfig: config,
      mediaId: "../evil path",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "invalid_media_reference" }));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("fails typed without any network call when the access token is missing", async () => {
    const { service, fetchWithTimeout } = createService();
    const result = await service.transcribe({
      channel: "whatsapp",
      connectionConfig: {},
      mediaId: "media-id-9000",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "missing_credentials" }));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("refuses oversized media declared by the lookup before downloading", async () => {
    const { service, fetchWithTimeout } = createService();
    fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media-id-9000",
        file_size: MAX_CHANNEL_VOICE_MEDIA_BYTES + 1,
      }),
    );
    const result = await service.transcribe({
      channel: "whatsapp",
      connectionConfig: config,
      mediaId: "media-id-9000",
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "media_too_large" }));
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});

describe("ChannelVoiceInboundService — byte sniffing (S12 mirror)", () => {
  it("rejects downloaded ZIP bytes claiming to be audio without invoking the transcriber", async () => {
    const { service, fetchWithTimeout, transcribeVoice } = createService();
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "voice/file_7.oga" } }))
      .mockResolvedValueOnce(bytesResponse(ZIP_BYTES));

    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "AwACAgIAAxkBAAIB",
      mimeType: "audio/ogg",
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "unsupported_media" }));
    expect(transcribeVoice).not.toHaveBeenCalled();
  });

  it("rejects non-audio declared MIME types before transcription", async () => {
    const { service, fetchWithTimeout, transcribeVoice } = createService();
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "docs/file.pdf" } }))
      .mockResolvedValueOnce(bytesResponse(OGG_BYTES));

    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "AwACAgIAAxkBAAIB",
      mimeType: "application/pdf",
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "unsupported_media" }));
    expect(transcribeVoice).not.toHaveBeenCalled();
  });

  it("returns a typed failure when the transcriber itself rejects the payload", async () => {
    const { service, fetchWithTimeout } = createService({
      transcribeVoice: vi.fn(async () => {
        throw new Error("Voice transcription bytes do not match the declared MIME hint");
      }),
    });
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "voice/file_7.oga" } }))
      .mockResolvedValueOnce(bytesResponse(OGG_BYTES));

    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "AwACAgIAAxkBAAIB",
      mimeType: "audio/ogg",
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "transcription_failed",
        detail: expect.stringContaining("do not match the declared MIME hint"),
      }),
    );
  });

  it("returns a typed failure for empty transcripts", async () => {
    const { service, fetchWithTimeout } = createService({
      transcribeVoice: vi.fn(async () => ({ text: "   " })),
    });
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { file_path: "voice/file_7.oga" } }))
      .mockResolvedValueOnce(bytesResponse(OGG_BYTES));

    const result = await service.transcribe({
      channel: "telegram",
      connectionConfig: { botToken: "123456:bot-secret" },
      fileId: "AwACAgIAAxkBAAIB",
      mimeType: "audio/ogg",
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "empty_transcript" }));
  });
});

describe("isAllowedWhatsAppMediaUrl", () => {
  it("allows Meta API and CDN hosts over https", () => {
    expect(isAllowedWhatsAppMediaUrl("https://graph.facebook.com/v23.0/123")).toBe(true);
    expect(isAllowedWhatsAppMediaUrl("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1")).toBe(true);
    expect(isAllowedWhatsAppMediaUrl("https://mmg.whatsapp.net/d/f/abc")).toBe(true);
    expect(isAllowedWhatsAppMediaUrl("https://scontent.xx.fbcdn.net/v/media")).toBe(true);
  });

  it("allows loopback for local test rigs", () => {
    expect(isAllowedWhatsAppMediaUrl("http://127.0.0.1:8080/media/1")).toBe(true);
    expect(isAllowedWhatsAppMediaUrl("http://localhost:8080/media/1")).toBe(true);
  });

  it("rejects lookalike, non-https, and unrelated hosts", () => {
    expect(isAllowedWhatsAppMediaUrl("https://graph.facebook.com.evil.io/media")).toBe(false);
    expect(isAllowedWhatsAppMediaUrl("http://graph.facebook.com/v23.0/123")).toBe(false);
    expect(isAllowedWhatsAppMediaUrl("https://attacker.example.com/media")).toBe(false);
    expect(isAllowedWhatsAppMediaUrl("https://evilfbsbx.com/media")).toBe(false);
    expect(isAllowedWhatsAppMediaUrl("not-a-url")).toBe(false);
  });
});
