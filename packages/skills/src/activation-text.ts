// File references describe operands, so their segments should not count as implicit skill intent.
// Handle quoted paths with spaces before stripping unquoted filenames and paths.
export function stripSkillFileReferences(text: string): string {
  return text
    .replace(/(["'`])(?:[A-Za-z]:[\\/]|[\\/]|[\p{L}\p{N}_.-]+[\\/])[^\r\n]*?\1/gu, " … ")
    .replace(/[^\s"'\x60<>()[\]{},;]+/gu, (token) =>
      /[\\/]/u.test(token) || /^\.?[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.[\p{L}][\p{L}\p{N}_-]*[.!?:]?$/u.test(token)
        ? " … "
        : token,
    );
}
