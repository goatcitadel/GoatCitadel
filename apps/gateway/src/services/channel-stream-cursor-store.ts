import type { AsyncStorage } from "@goatcitadel/storage";

/**
 * Durable provider cursor for a channel stream (for example a Matrix /sync `since` token).
 * Kept in system settings, not in the connection config, so advancing it never bumps the
 * connection revision (which would restart the stream runner).
 */
export interface ChannelStreamCursorStore {
  read(channelKey: string, connectionId: string): Promise<{ cursor: string; scope?: string } | undefined>;
  write(channelKey: string, connectionId: string, value: { cursor: string; scope?: string }): Promise<void>;
}

export const CHANNEL_STREAM_CURSOR_SETTING_PREFIX = "channel_stream_cursor_v1";

interface StoredCursor {
  cursor?: unknown;
  scope?: unknown;
  updatedAt?: unknown;
}

function settingKey(channelKey: string, connectionId: string): string {
  return `${CHANNEL_STREAM_CURSOR_SETTING_PREFIX}:${channelKey}:${connectionId}`;
}

export function createSystemSettingsChannelStreamCursorStore(
  systemSettings: Pick<AsyncStorage["systemSettings"], "get" | "set">,
  now: () => Date = () => new Date(),
): ChannelStreamCursorStore {
  return {
    async read(channelKey, connectionId) {
      const saved = await systemSettings.get<StoredCursor>(settingKey(channelKey, connectionId));
      const value = saved?.value;
      if (!value || typeof value.cursor !== "string" || value.cursor.length === 0) return undefined;
      return typeof value.scope === "string" ? { cursor: value.cursor, scope: value.scope } : { cursor: value.cursor };
    },
    async write(channelKey, connectionId, value) {
      await systemSettings.set(settingKey(channelKey, connectionId), {
        cursor: value.cursor,
        ...(value.scope !== undefined ? { scope: value.scope } : {}),
        updatedAt: now().toISOString(),
      });
    },
  };
}
