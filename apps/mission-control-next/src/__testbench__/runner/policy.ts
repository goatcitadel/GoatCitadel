import type { TargetInfo } from "../gateway-target/detect-target";
import type { CheckDef, RunOptions } from "./types";

export type Permission = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

const ALLOWED: Permission = { allowed: true };

export function checkPermission(
  check: Pick<CheckDef, "id" | "tier" | "realSafe">,
  target: Pick<TargetInfo, "kind">,
  options: RunOptions,
): Permission {
  const inSandbox = target.kind === "sandbox";
  switch (check.tier) {
    case "read":
      return ALLOWED;
    case "mutate":
      return inSandbox ? ALLOWED : deny("Mutating checks never run on the real gateway.");
    case "host":
      if (!inSandbox) {
        return deny("Host checks never run on the real gateway.");
      }
      return options.allowHost
        ? ALLOWED
        : deny('Host checks are off for this run. Tick "Allow host checks" to run them.');
    case "external":
      if (!inSandbox && check.realSafe !== true) {
        return deny("Only allowlisted external checks run on the real gateway.");
      }
      return options.confirmedExternalIds.has(check.id)
        ? ALLOWED
        : deny("External checks run only after you confirm them.");
  }
}

function deny(reason: string): Permission {
  return { allowed: false, reason };
}
