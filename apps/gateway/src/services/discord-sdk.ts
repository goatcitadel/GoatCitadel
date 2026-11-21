import { createRequire } from "node:module";

const requireDiscordSdk = createRequire(import.meta.url);

export function loadDiscordSdk(): typeof import("discord.js") {
  return requireDiscordSdk("discord.js") as typeof import("discord.js");
}
