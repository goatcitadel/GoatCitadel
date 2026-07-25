import type { WorkspacePathFlavor } from "@goatcitadel/contracts";

/**
 * Raised when a resolve request names a path flavor the host cannot serve —
 * a Windows flavor on a POSIX host, or `posix` on a Windows host.
 *
 * This is a property of the request, not a server fault, so routes map it to a
 * client error. Without it the mismatch escapes as an untyped error and the
 * caller sees an opaque 500.
 */
export class WorkspacePathBridgeUnsupportedFlavorError extends Error {
  public readonly code = "unsupported_path_flavor";

  public constructor(
    public readonly hostPlatform: "windows" | "posix",
    public readonly requestedFlavor: WorkspacePathFlavor,
  ) {
    super(`This host resolves ${hostPlatform} path flavors; "${requestedFlavor}" is not one of them.`);
    this.name = "WorkspacePathBridgeUnsupportedFlavorError";
  }
}

export function isWorkspacePathBridgeUnsupportedFlavorError(
  error: unknown,
): error is WorkspacePathBridgeUnsupportedFlavorError {
  return error instanceof WorkspacePathBridgeUnsupportedFlavorError;
}
