import type { OpenAIRealtimeVoiceSurface } from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";

const OPENAI_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const OPENAI_REALTIME_RESPONSE_MAX_BYTES = 64_000;
const OPENAI_REALTIME_RESPONSE_TIMEOUT_MS = 5_000;
export const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-2.1";
export const DEFAULT_OPENAI_REALTIME_VOICE = "marin";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class OpenAIRealtimeVoiceError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 502,
  ) {
    super(message);
    this.name = "OpenAIRealtimeVoiceError";
  }
}

export interface OpenAIRealtimeClientSecretInput {
  apiKey: string;
  safetyIdentifier: string;
  surface: OpenAIRealtimeVoiceSurface;
  model?: string;
  voice?: string;
  instructionsProfile?: string;
}

export interface OpenAIRealtimeClientSecretResult {
  value: string;
  expiresAt?: string;
  model: string;
  voice: string;
}

export interface OpenAIRealtimeVoiceServiceDeps {
  fetcher?: FetchLike;
}

export class OpenAIRealtimeVoiceService {
  private readonly fetcher: FetchLike;

  public constructor(deps: OpenAIRealtimeVoiceServiceDeps = {}) {
    this.fetcher = deps.fetcher ?? ((input, init) => fetch(input, init));
  }

  public async createClientSecret(input: OpenAIRealtimeClientSecretInput): Promise<OpenAIRealtimeClientSecretResult> {
    const apiKey = input.apiKey.trim();
    if (!apiKey) {
      throw new OpenAIRealtimeVoiceError("OpenAI Realtime voice requires OPENAI_API_KEY.", 400);
    }

    const model = normalizeRealtimeModel(input.model);
    const voice = normalizeRealtimeVoice(input.voice);
    const response = await this.fetcher(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": input.safetyIdentifier,
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model,
          instructions: buildRealtimeInstructions(input.surface, input.instructionsProfile),
          audio: {
            output: {
              voice,
            },
          },
        },
      }),
    });

    const rawText = await readBoundedResponseText(response, {
      maxBytes: OPENAI_REALTIME_RESPONSE_MAX_BYTES,
      timeoutMs: OPENAI_REALTIME_RESPONSE_TIMEOUT_MS,
      label: "OpenAI Realtime client secret",
    });
    const parsed = parseJsonRecord(rawText);
    if (!response.ok) {
      throw new OpenAIRealtimeVoiceError(
        `OpenAI Realtime client-secret request failed (${response.status}): ${extractErrorMessage(parsed, rawText)}`,
        response.status >= 500 ? 502 : 400,
      );
    }

    const clientSecret = normalizeClientSecretPayload(parsed);
    return {
      ...clientSecret,
      model,
      voice,
    };
  }
}

export function normalizeRealtimeModel(value?: string): string {
  const envDefault = process.env.GOATCITADEL_OPENAI_REALTIME_MODEL?.trim();
  return value?.trim() || envDefault || DEFAULT_OPENAI_REALTIME_MODEL;
}

export function normalizeRealtimeVoice(value?: string): string {
  const envDefault = process.env.GOATCITADEL_OPENAI_REALTIME_VOICE?.trim();
  return value?.trim() || envDefault || DEFAULT_OPENAI_REALTIME_VOICE;
}

function buildRealtimeInstructions(surface: OpenAIRealtimeVoiceSurface, profile?: string): string {
  const profileLabel = profile?.trim() || surface;
  if (surface === "google-meet") {
    return [
      "You are GoatCitadel's OpenAI Realtime voice assistant for a supervised Google Meet session.",
      "Keep spoken responses concise and operator-safe.",
      "Do not claim access to meeting controls, external tools, files, or private business logic unless Gateway provides them.",
      `Instructions profile: ${profileLabel}.`,
    ].join(" ");
  }

  return [
    "You are GoatCitadel's OpenAI Realtime voice assistant inside the current chat.",
    "Keep the conversation natural, concise, and transparent about uncertainty.",
    "Do not claim tool execution, durable memory writes, file access, or external side effects unless Gateway explicitly performs them.",
    `Instructions profile: ${profileLabel}.`,
  ].join(" ");
}

function parseJsonRecord(rawText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeClientSecretPayload(payload: Record<string, unknown>): { value: string; expiresAt?: string } {
  const nested = isRecord(payload.client_secret) ? payload.client_secret : payload;
  const value = readString(nested.value) ?? readString(payload.value);
  if (!value) {
    throw new OpenAIRealtimeVoiceError("OpenAI Realtime returned no ephemeral client secret.", 502);
  }
  const expiresAt = normalizeExpiresAt(
    nested.expires_at ?? nested.expiresAt ?? payload.expires_at ?? payload.expiresAt,
  );
  return {
    value,
    expiresAt,
  };
}

function normalizeExpiresAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  const raw = readString(value);
  if (!raw) {
    return undefined;
  }
  if (/^\d+$/.test(raw)) {
    return normalizeExpiresAt(Number.parseInt(raw, 10));
  }
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : raw;
}

function extractErrorMessage(payload: Record<string, unknown>, rawText: string): string {
  const nested = isRecord(payload.error) ? payload.error : payload;
  const message = (readString(nested.message) ?? readString(payload.message) ?? rawText.trim()) || "upstream error";
  return message.slice(0, 400);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const __openAIRealtimeVoiceServiceInternals = {
  normalizeRealtimeModel,
  normalizeRealtimeVoice,
};
