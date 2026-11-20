import type { PracticeSession } from "./practice-fixture.js";
export function mountTutorialGuide(
  session: PracticeSession,
  navigateTo: (href: string) => void,
  leave: (reason: string) => void,
): () => void;
