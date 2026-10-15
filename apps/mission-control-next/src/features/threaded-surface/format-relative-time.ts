export function formatRelativeTime(value?: string): string {
  if (!value) {
    return "Recent";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "Recent";
  }
  const deltaMinutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}
