const FIXED_OUTBOUND_HOSTS_BY_TOOL = new Map<string, string[]>([
  ["calendar.create_event", ["www.googleapis.com"]],
  ["calendar.list", ["www.googleapis.com"]],
  ["discord.react", ["discord.com"]],
  ["discord.send", ["discord.com"]],
  ["discord.unsend", ["discord.com"]],
  ["gmail.read", ["gmail.googleapis.com"]],
  ["gmail.send", ["gmail.googleapis.com"]],
  ["line.send", ["api.line.me"]],
  ["slack.react", ["slack.com"]],
  ["slack.send", ["slack.com"]],
  ["slack.unsend", ["slack.com"]],
  ["telegram.react", ["api.telegram.org"]],
  ["telegram.send", ["api.telegram.org"]],
  ["telegram.unsend", ["api.telegram.org"]],
  ["whatsapp.react", ["graph.facebook.com"]],
  ["whatsapp.send", ["graph.facebook.com"]],
  ["zalo.send", ["openapi.zalo.me"]],
]);

const FIXED_OUTBOUND_HOSTS_BY_CHANNEL_KEY = new Map<string, string[]>([
  ["discord", ["discord.com"]],
  ["gmail", ["gmail.googleapis.com"]],
  ["google-calendar", ["www.googleapis.com"]],
  ["line", ["api.line.me"]],
  ["slack", ["slack.com"]],
  ["telegram", ["api.telegram.org"]],
  ["whatsapp", ["graph.facebook.com"]],
  ["zalo", ["openapi.zalo.me"]],
]);

export function resolveFixedOutboundHostsForTool(toolName: string, connectionKey?: string): string[] {
  const hosts = new Set(FIXED_OUTBOUND_HOSTS_BY_TOOL.get(toolName) ?? []);
  if (connectionKey && (toolName === "channel.send" || toolName === "channel.react" || toolName === "channel.unsend")) {
    for (const host of FIXED_OUTBOUND_HOSTS_BY_CHANNEL_KEY.get(connectionKey) ?? []) {
      hosts.add(host);
    }
  }
  return [...hosts];
}
