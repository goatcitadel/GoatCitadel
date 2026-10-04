export const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  admin: "Admin & backups",
  approvals: "Approvals",
  capabilities: "Capabilities",
  chat: "Chat",
  "code-mode": "Code Mode",
  durable: "Durable runs",
  events: "Realtime",
  health: "Health",
  llm: "Providers",
  memory: "Memory",
  ops: "Ops",
};

export function domainLabel(domain: string): string {
  const known = DOMAIN_LABELS[domain];
  if (known) {
    return known;
  }
  const spaced = domain.replace(/[-_]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
