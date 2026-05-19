const PROMPT_INJECTION_MARKERS = [
  /\bignore (?:all )?(?:previous|prior|above) (?:instructions|messages|rules)\b/i,
  /\bdisregard (?:all )?(?:previous|prior|above) (?:instructions|messages|rules)\b/i,
  /\boverride (?:the )?(?:system|developer) (?:prompt|message|instructions)\b/i,
  /\breveal (?:the )?(?:system|developer) (?:prompt|message|instructions)\b/i,
  /\byou are now (?:in|under) developer mode\b/i,
];

export interface AssembledPromptInjectionFinding {
  marker: string;
}

export function scanAssembledPromptForInjection(prompt: string): AssembledPromptInjectionFinding | undefined {
  for (const marker of PROMPT_INJECTION_MARKERS) {
    if (marker.test(prompt)) {
      return { marker: marker.source };
    }
  }
  return undefined;
}

export function assertNoAssembledPromptInjection(prompt: string): void {
  const finding = scanAssembledPromptForInjection(prompt);
  if (finding) {
    throw new Error(`Assembled prompt failed prompt-injection scan: ${finding.marker}`);
  }
}
