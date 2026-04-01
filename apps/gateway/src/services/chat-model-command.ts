export interface ParsedChatModelCommandTarget {
  providerId?: string;
  model: string;
}

export function parseChatModelCommandTarget(input: string): ParsedChatModelCommandTarget | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("/")) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return { model: trimmed };
  }
  const providerId = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!providerId || !model) {
    return null;
  }
  return {
    providerId,
    model,
  };
}
