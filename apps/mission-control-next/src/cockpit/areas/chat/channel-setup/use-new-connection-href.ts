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
 * Whether a bot is already a GoatCitadel channel: "checking" until the connections have been read, then "connected"
 * with that channel's page, or "none". A second channel for one bot would fight the first for its messages.
 */
export type ConnectedBot = { state: "checking" } | { state: "none" } | { state: "connected"; href: string };

/**
 * Looks once for a channel this bot already is, as soon as the bot is known; the same bot is not looked for again,
 * so the channel a setup goes on to make is never taken for an earlier one. When the connections cannot be read it
 * claims nothing and the setup goes on.
 */
export function useConnectedTelegramBot(botUsername: string | undefined): ConnectedBot {
  const [found, setFound] = useState<{ bot: string; href?: string }>();
  useEffect(() => {
    if (!botUsername) return;
    let current = true;
    const answer = (href?: string) => {
      if (current) setFound({ bot: botUsername, ...(href ? { href } : {}) });
    };
    void fetchIntegrationConnections("channel").then(
      ({ items }) => {
        const connection = newestTelegramConnection(items, botUsername);
        answer(connection ? channelPageHref(connection.connectionId) : undefined);
      },
      () => answer(),
    );
    return () => {
      current = false;
    };
  }, [botUsername]);
  if (!botUsername) return { state: "none" };
  if (found?.bot !== botUsername) return { state: "checking" };
  return found.href ? { state: "connected", href: found.href } : { state: "none" };
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
