/**
 * Pure helpers extracted from ToolsPage.tsx (Step 10 page slimming).
 */

export interface IdOption {
  value: string;
  label: string;
}

export function toDatetimeLocalValue(isoUtc?: string): string {
  if (!isoUtc) {
    return "";
  }
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function formatSessionOption(session: {
  sessionId: string;
  title?: string;
  scope: string;
  updatedAt: string;
  channel: string;
  account: string;
}): string {
  const title = session.title?.trim() || `${session.channel}:${session.account}`;
  const timestamp = new Date(session.updatedAt).toLocaleString();
  return `${title} (${session.scope}) • ${session.sessionId} • ${timestamp}`;
}

export function dedupeOptions(options: IdOption[]): IdOption[] {
  const seen = new Set<string>();
  const deduped: IdOption[] = [];
  for (const option of options) {
    const key = option.value.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(option);
  }
  return deduped;
}

export function ensureCurrentOption(options: IdOption[], currentValue: string, fallbackPrefix: string): IdOption[] {
  const list = dedupeOptions(options);
  if (!currentValue.trim()) {
    return list;
  }
  if (list.some((option) => option.value === currentValue)) {
    return list;
  }
  return [{ value: currentValue, label: `${fallbackPrefix}: ${currentValue}` }, ...list];
}
