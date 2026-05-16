const CATALOG: Readonly<Record<string, string>> = {
  "shell.summary.empty": "Empty command.",
  "shell.summary.unparsed": "Command could not be parsed.",
};

export function t(key: string): string {
  return CATALOG[key] ?? key;
}
