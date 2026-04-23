const HTML_BOUNDARY_CHARS = new Set([" ", "\t", "\n", "\r", "\f", "/", ">"]);

export function stripHtmlNoiseTags(input: string, tags: readonly string[]): string {
  if (!input || tags.length === 0) {
    return input;
  }

  const lower = input.toLowerCase();
  let cursor = 0;
  let output = "";

  while (cursor < input.length) {
    const openTagIndex = lower.indexOf("<", cursor);
    if (openTagIndex < 0) {
      output += input.slice(cursor);
      break;
    }

    output += input.slice(cursor, openTagIndex);

    const tagName = matchNoiseTag(lower, openTagIndex, tags);
    if (!tagName) {
      output += input[openTagIndex] ?? "";
      cursor = openTagIndex + 1;
      continue;
    }

    const startTagEnd = lower.indexOf(">", openTagIndex + 1);
    if (startTagEnd < 0) {
      output += " ";
      break;
    }

    const closingTagIndex = findClosingTagIndex(lower, tagName, startTagEnd + 1);
    if (closingTagIndex < 0) {
      output += " ";
      cursor = startTagEnd + 1;
      continue;
    }

    const closingTagEnd = lower.indexOf(">", closingTagIndex + 2 + tagName.length);
    output += " ";
    cursor = closingTagEnd < 0 ? input.length : closingTagEnd + 1;
  }

  return output;
}

export function stripHtmlTags(input: string): string {
  if (!input) {
    return input;
  }

  let cursor = 0;
  let output = "";
  while (cursor < input.length) {
    const openTagIndex = input.indexOf("<", cursor);
    if (openTagIndex < 0) {
      output += input.slice(cursor);
      break;
    }

    const tagEnd = findTagEnd(input, openTagIndex + 1);
    if (tagEnd < 0) {
      output += input.slice(cursor);
      break;
    }

    output += input.slice(cursor, openTagIndex);
    output += " ";
    cursor = tagEnd + 1;
  }

  return output;
}

function matchNoiseTag(input: string, openTagIndex: number, tags: readonly string[]): string | undefined {
  for (const tagName of tags) {
    const openingToken = `<${tagName}`;
    if (!input.startsWith(openingToken, openTagIndex)) {
      continue;
    }
    const boundary = input[openTagIndex + openingToken.length];
    if (boundary === undefined || HTML_BOUNDARY_CHARS.has(boundary)) {
      return tagName;
    }
  }
  return undefined;
}

function findClosingTagIndex(input: string, tagName: string, searchFrom: number): number {
  const closingToken = `</${tagName}`;
  let cursor = input.indexOf(closingToken, searchFrom);
  while (cursor >= 0) {
    const boundary = input[cursor + closingToken.length];
    if (boundary === undefined || HTML_BOUNDARY_CHARS.has(boundary)) {
      return cursor;
    }
    cursor = input.indexOf(closingToken, cursor + 1);
  }
  return -1;
}

function findTagEnd(input: string, searchFrom: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = searchFrom; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return index;
    }
  }
  return -1;
}
