const key = "goatcitadel.first-run-tutorial.v1";
export const practiceMarker = "firstRunTutorial";
const returnKey = key + ".return";

export interface TutorialHandoff {
  citadelId: string;
  workspaceId: string;
}

export function openTutorial(scope: TutorialHandoff): boolean {
  try {
    sessionStorage.setItem(key, JSON.stringify(scope));
  } catch {
    return false;
  }
  location.replace("/chat?shell=cockpit&" + practiceMarker + "=1");
  return true;
}

function parseScope(value: string | null): TutorialHandoff | undefined {
  try {
    const scope = JSON.parse(value ?? "null") as Partial<TutorialHandoff> | null;
    const valid = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9_-]{1,128}$/i.test(id);
    return valid(scope?.citadelId) && valid(scope?.workspaceId)
      ? { citadelId: scope.citadelId, workspaceId: scope.workspaceId }
      : undefined;
  } catch {
    return undefined;
  }
}

export function takeTutorialHandoff(): TutorialHandoff | undefined {
  try {
    const value = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    return parseScope(value);
  } catch {
    return undefined;
  }
}

export function recordTutorialReturn(scope: TutorialHandoff): boolean {
  try {
    sessionStorage.setItem(returnKey, JSON.stringify(scope));
    return true;
  } catch {
    // The regular Cockpit still opens with its saved scope.
    return false;
  }
}

export function readTutorialReturn(): TutorialHandoff | undefined {
  try {
    return parseScope(sessionStorage.getItem(returnKey));
  } catch {
    return undefined;
  }
}

export function clearTutorialReturn(): boolean {
  try {
    sessionStorage.removeItem(returnKey);
    return true;
  } catch {
    // Session storage can become unavailable before the transition finishes.
    return false;
  }
}
