import { canonicalJsonString, type AddonStatusRecord } from "@goatcitadel/contracts";

export type AddonAction = "install" | "update" | "enable" | "disable" | "launch" | "stop" | "uninstall";
export const ADDON_ACTIONS: AddonAction[] = ["install", "update", "enable", "disable", "launch", "stop", "uninstall"];
export const ADDON_OWNER_BOUNDARY =
  "Add-ons are experimental host applications. Installation and update download and build repository code on this computer. These APIs have no atomic revision precondition; the current owner record is checked before dispatch.";
export const addonRecordsEqual = (a: unknown, b: unknown) => canonicalJsonString(a) === canonicalJsonString(b);

export function assertAddonStatus(value: AddonStatusRecord, addonId: string) {
  const installed = value.installed;
  if (
    !addonId ||
    value.addon?.addonId !== addonId ||
    !value.addon.repoUrl ||
    !value.addon.owner ||
    value.addon.requiresSeparateRepoDownload !== true ||
    !Array.isArray(value.addon.installCommands) ||
    !Array.isArray(value.healthChecks) ||
    !["not_installed", "installed", "disabled", "running", "stopped", "error"].includes(value.status) ||
    (installed
      ? value.status === "not_installed" ||
        installed.addonId !== addonId ||
        !installed.installedPath ||
        installed.repoUrl !== value.addon.repoUrl ||
        installed.owner !== value.addon.owner ||
        installed.trustTier !== value.addon.trustTier ||
        installed.runtimeType !== value.addon.runtimeType ||
        installed.sameOwnerAsGoatCitadel !== value.addon.sameOwnerAsGoatCitadel ||
        installed.runtimeStatus !== value.status ||
        !installed.consentedBy ||
        !Number.isFinite(Date.parse(installed.installedAt)) ||
        !Number.isFinite(Date.parse(installed.updatedAt)) ||
        !Number.isFinite(Date.parse(installed.consentedAt))
      : value.status !== "not_installed")
  )
    throw new Error("The add-on owner record is missing, contradictory, or belongs to another add-on.");
}

export function addonActionAvailable(action: AddonAction, value: AddonStatusRecord) {
  const installed = value.installed;
  const enabled = Boolean(installed && installed.enabled !== false && value.status !== "disabled");
  switch (action) {
    case "install":
      return !installed && value.status === "not_installed";
    case "update":
      return Boolean(installed && value.status !== "running" && !installed.pid);
    case "enable":
      return Boolean(installed && !enabled);
    case "disable":
      return enabled;
    case "launch":
      return enabled && value.addon.addonId === "arena" && value.status !== "running";
    case "stop":
      return enabled && ["running", "error"].includes(value.status);
    case "uninstall":
      return Boolean(installed);
  }
}

export function addonReviewDescription(action: AddonAction, value: AddonStatusRecord) {
  const consequences: Record<AddonAction, string> = {
    install:
      "Download the catalog repository, install dependencies, and run its build commands. The new installation starts disabled and requires separate enable and launch actions.",
    update:
      "Download and build the catalog revision, replace the stopped installation, and retain the owner's managed Arena data. This does not launch the add-on.",
    enable: "Enable the installed add-on and register its declared UI slots. This does not start its process.",
    disable: "Stop the add-on's recorded process, disable its installation, and remove its UI slots.",
    launch:
      "Start the trusted local Arena process and check its local UI health. A recorded error is not a successful launch.",
    stop: "Stop the add-on's recorded process. The installed application remains available.",
    uninstall:
      "Stop the recorded process and remove the managed installation, manifest record, and UI slots. This is not a guarantee that all retained application data is erased.",
  };
  return `${value.addon.label} · ${value.addon.addonId} · installation-wide action. Repository: ${value.addon.repoUrl}. ${consequences[action]} ${ADDON_OWNER_BOUNDARY}`;
}

export function assertAddonReceipt(
  action: Exclude<AddonAction, "uninstall">,
  before: AddonStatusRecord,
  saved: AddonStatusRecord,
) {
  assertAddonStatus(saved, before.addon.addonId);
  if (!addonRecordsEqual(saved.addon, before.addon) || !saved.installed)
    throw new Error("The returned add-on does not match the reviewed catalog and installation.");
  const after = saved.installed,
    prior = before.installed;
  if (
    prior &&
    (after.installedPath !== prior.installedPath ||
      after.installedAt !== prior.installedAt ||
      after.consentedAt !== prior.consentedAt ||
      after.consentedBy !== prior.consentedBy)
  )
    throw new Error("The add-on installation identity changed in the action receipt.");
  if (action === "install" || action === "update") {
    const pins = before.addon.installCommands.flatMap((command) =>
      command.command === "git" && command.args?.includes("checkout")
        ? command.args.filter((arg) => /^[a-f0-9]{40}$/.test(arg))
        : [],
    );
    if (pins.length !== 1 || after.installRef !== pins[0])
      throw new Error("The returned installation does not match the immutable catalog revision.");
  }
  const expected =
    action === "install" || action === "disable"
      ? saved.status === "disabled" && after.enabled === false && !after.pid
      : action === "enable"
        ? after.enabled === true && saved.status !== "disabled"
        : action === "stop"
          ? saved.status === "stopped" && !after.pid
          : action === "launch"
            ? ["running", "error"].includes(saved.status) && after.enabled === true
            : Boolean(prior && after.enabled === prior.enabled && saved.status !== "running" && !after.pid);
  if (!expected) throw new Error("The Gateway did not confirm the reviewed add-on lifecycle action.");
}
