import { z } from "zod";

const CHANNEL_INBOUND_MAX_CONTENT_CHARS = 20_000;

export const connectionParamsSchema = z.object({
  connectionId: z.string().uuid(),
});

export const channelParamsSchema = z.object({
  channel: z.string().min(1),
});

export const channelConnectionInboundParamsSchema = z.object({
  connectionId: z.string().uuid(),
  channel: z.string().min(1),
});

export const channelInboundSchema = z.object({
  eventId: z.string().min(1),
  account: z.string().min(1),
  peer: z.string().optional(),
  room: z.string().optional(),
  threadId: z.string().optional(),
  actorId: z.string().min(1),
  content: z.string().min(1).max(CHANNEL_INBOUND_MAX_CONTENT_CHARS),
  displayName: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});
