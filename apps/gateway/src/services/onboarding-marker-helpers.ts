import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export interface OnboardingMarkerHost {
  readonly onboardingMarkerPath: string;
  onboardingMarker: {
    completedAt?: string;
    completedBy?: string;
  };
}

export async function loadOnboardingMarker(host: OnboardingMarkerHost): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(host.onboardingMarkerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      host.onboardingMarker = {};
      return;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as { completedAt?: string; completedBy?: string };
    host.onboardingMarker = {
      completedAt: parsed.completedAt?.trim() || undefined,
      completedBy: parsed.completedBy?.trim() || undefined,
    };
  } catch {
    host.onboardingMarker = {};
  }
}

export function persistOnboardingMarker(host: OnboardingMarkerHost): void {
  fsSync.mkdirSync(path.dirname(host.onboardingMarkerPath), { recursive: true });
  fsSync.writeFileSync(host.onboardingMarkerPath, JSON.stringify(host.onboardingMarker, null, 2), "utf8");
}
