import { useEffect, useState } from "react";
import { fetchIntegrationConnections } from "@goatcitadel/mission-control-shared/api/client";
import type { IntegrationConnection } from "@goatcitadel/mission-control-shared/api/types";
import { channelPageHref } from "../../../app/routes";

const bare = (username: string) => username.trim().replace(/^@/u, "").toLowerCase();
const created = (connection: IntegrationConnection) => Date.parse(connection.createdAt) || 0;

/**
 * The connection just made for a Telegram bot: the newest Telegram connection whose bot has this username, with or
 * without the @ and in any case. A connection that does not name a bot is never taken for this one.
 */
export function newestTelegramConnection(
  connections: readonly IntegrationConnection[],
  botUsername: string,
): IntegrationConnection | undefined {
  const wanted = bare(botUsername);
  const theirs = connections.filter(
    (connection) =>
      connection.key === "telegram" &&
      typeof connection.config.botUsername === "string" &&
      bare(connection.config.botUsername) === wanted,
  );
  // `theirs` is a new list, so sorting it leaves the caller's list as it was.
  return theirs.sort((a, b) => created(b) - created(a))[0];
}

/**
 * Where the new Telegram channel's page is, once the setup has been turned on. It looks once, when `done` turns true;
 * when the connections cannot be read or none is the bot's, there is no link and the page says it is on without one.
 */
export function useNewTelegramHref(done: boolean, botUsername: string | undefined): string | undefined {
  const [href, setHref] = useState<string>();
  useEffect(() => {
    setHref(undefined);
    if (!done || !botUsername) return;
    let current = true;
    void fetchIntegrationConnections("channel").then(
      ({ items }) => {
        const found = newestTelegramConnection(items, botUsername);
        if (current && found) setHref(channelPageHref(found.connectionId));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [done, botUsername]);
  return href;
}
