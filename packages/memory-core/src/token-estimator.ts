export type TokenEstimatorMode = "exact" | "heuristic";

export interface TokenEstimateOptions {
  model?: string;
}

export interface TokenEstimateResult {
  count: number;
  mode: TokenEstimatorMode;
  estimator: string;
}

export interface TokenEstimatorPlugin {
  name: string;
  estimate: (input: string, options?: TokenEstimateOptions) => number | undefined;
}

const estimatorPlugins: TokenEstimatorPlugin[] = [];

export function registerTokenEstimator(plugin: TokenEstimatorPlugin): void {
  const existingIndex = estimatorPlugins.findIndex((item) => item.name === plugin.name);
  if (existingIndex >= 0) {
    estimatorPlugins.splice(existingIndex, 1, plugin);
    return;
  }
  estimatorPlugins.unshift(plugin);
}

export function clearRegisteredTokenEstimators(): void {
  estimatorPlugins.length = 0;
}

export function estimateTokens(input: string, options?: TokenEstimateOptions): TokenEstimateResult {
  if (!input) {
    return {
      count: 0,
      mode: "heuristic",
      estimator: "empty",
    };
  }

  for (const plugin of estimatorPlugins) {
    try {
      const count = plugin.estimate(input, options);
      if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
        return {
          count: Math.ceil(count),
          mode: "exact",
          estimator: plugin.name,
        };
      }
    } catch {
      continue;
    }
  }

  return {
    count: heuristicEstimateTokens(input),
    mode: "heuristic",
    estimator: "goatcitadel-heuristic-v2",
  };
}

export function estimateTokensFromText(input: string, options?: TokenEstimateOptions): number {
  return estimateTokens(input, options).count;
}

export function truncateByTokenEstimate(input: string, maxTokens: number, options?: TokenEstimateOptions): string {
  if (maxTokens <= 0 || !input) {
    return "";
  }
  if (estimateTokensFromText(input, options) <= maxTokens) {
    return input;
  }

  const suffix = "\n...[truncated]";
  const suffixBudget = estimateTokensFromText(suffix, options);
  const targetBudget = Math.max(1, maxTokens - suffixBudget);

  let low = 0;
  let high = input.length;
  let best = "";

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = input.slice(0, mid);
    const estimated = estimateTokensFromText(candidate, options);
    if (estimated <= targetBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const trimmed = best.trimEnd();
  if (!trimmed) {
    return suffix.trimStart();
  }
  return `${trimmed}${suffix}`;
}

function heuristicEstimateTokens(input: string): number {
  let count = 0;
  let currentWord = "";

  const flushWord = () => {
    if (!currentWord) {
      return;
    }
    count += estimateWordTokenCost(currentWord);
    currentWord = "";
  };

  for (const char of input) {
    if (isWhitespace(char)) {
      flushWord();
      continue;
    }
    if (isCjk(char)) {
      flushWord();
      count += 1;
      continue;
    }
    if (isWordLike(char)) {
      currentWord += char;
      continue;
    }
    flushWord();
    count += isDensePunctuation(char) ? 1 : 2;
  }

  flushWord();
  return Math.max(1, count);
}

function estimateWordTokenCost(word: string): number {
  if (looksLikeUrl(word)) {
    return Math.max(2, Math.ceil(word.length / 3));
  }
  if (looksLikePath(word)) {
    const segments = word.split(/[\\/]/).filter(Boolean).length;
    return Math.max(1, segments + Math.ceil(word.length / 6));
  }
  if (looksLikeCodeIdentifier(word)) {
    return Math.max(1, Math.ceil(splitIdentifier(word).length * 0.8));
  }
  return Math.max(1, Math.ceil(word.length / 5));
}

function splitIdentifier(input: string): string[] {
  return input
    .split(/[_\-.:]+/)
    .flatMap((part) => part.split(/(?=[A-Z])/))
    .filter(Boolean);
}

function looksLikeUrl(word: string): boolean {
  return /^https?:\/\//i.test(word) || /^www\./i.test(word);
}

function looksLikePath(word: string): boolean {
  return /[\\/]/.test(word) || /^[A-Za-z]:/.test(word);
}

function looksLikeCodeIdentifier(word: string): boolean {
  return /[_:.()-]/.test(word) || /[a-z][A-Z]/.test(word);
}

const WHITESPACE_CHARS = new Set(
  " \n\r\t\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
);
const DENSE_PUNCT_CHARS = new Set("()[]{}<>=+*%,;!?'\"`|&");
const WORD_LIKE_ASCII = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/\\:.-");
const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const UNICODE_WORD_REGEX = /[\p{L}\p{N}]/u;

function isWhitespace(char: string): boolean {
  return WHITESPACE_CHARS.has(char);
}

function isWordLike(char: string): boolean {
  if (WORD_LIKE_ASCII.has(char)) {
    return true;
  }
  return UNICODE_WORD_REGEX.test(char);
}

function isDensePunctuation(char: string): boolean {
  return DENSE_PUNCT_CHARS.has(char);
}

function isCjk(char: string): boolean {
  return CJK_REGEX.test(char);
}
