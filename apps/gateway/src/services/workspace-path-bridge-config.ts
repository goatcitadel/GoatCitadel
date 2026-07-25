export type WorkspacePathBridgePathSource = { flavor: "msys" } | { flavor: "wsl"; distro: string };

export interface WorkspacePathBridgeRuntimeConfig {
  pathSource?: WorkspacePathBridgePathSource;
}

const PATH_SOURCE_ENV = "GOATCITADEL_WORKSPACE_PATH_SOURCE";
const WSL_DISTRO_ENV = "GOATCITADEL_WORKSPACE_PATH_WSL_DISTRO";
const BOUNDED_WSL_DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * Reads the process-owned path dialect once during Gateway construction. Tool
 * arguments never participate in this choice: an absolute POSIX path is MSYS
 * or WSL only when the operator configured that provenance explicitly.
 */
export function resolveWorkspacePathBridgeRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  hostPlatform: "windows" | "posix" = process.platform === "win32" ? "windows" : "posix",
): WorkspacePathBridgeRuntimeConfig {
  const rawSource = environment[PATH_SOURCE_ENV];
  const rawDistro = environment[WSL_DISTRO_ENV];
  const source = rawSource === undefined || rawSource === "" ? undefined : rawSource;
  const distro = rawDistro === undefined || rawDistro === "" ? undefined : rawDistro;

  if (hostPlatform === "posix" && (source !== undefined || distro !== undefined)) {
    throw new Error(`${PATH_SOURCE_ENV} and ${WSL_DISTRO_ENV} are Windows-host-only settings.`);
  }

  if (source === undefined) {
    if (distro !== undefined) {
      throw new Error(`${WSL_DISTRO_ENV} requires ${PATH_SOURCE_ENV}=wsl.`);
    }
    return {};
  }
  if (source === "msys") {
    if (distro !== undefined) {
      throw new Error(`${WSL_DISTRO_ENV} is forbidden when ${PATH_SOURCE_ENV}=msys.`);
    }
    return { pathSource: { flavor: "msys" } };
  }
  if (source === "wsl") {
    if (!distro || !BOUNDED_WSL_DISTRO.test(distro)) {
      throw new Error(
        `${PATH_SOURCE_ENV}=wsl requires a bounded ${WSL_DISTRO_ENV} matching ${BOUNDED_WSL_DISTRO.source}.`,
      );
    }
    return { pathSource: { flavor: "wsl", distro } };
  }
  throw new Error(`${PATH_SOURCE_ENV} must be unset, msys, or wsl.`);
}
