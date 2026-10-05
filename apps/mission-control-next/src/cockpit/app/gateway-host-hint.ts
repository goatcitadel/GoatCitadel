import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";

export interface GatewayHost {
  desktopApp: boolean;
  hostname: string;
}

const SAME_MACHINE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Where the Gateway this page talks to runs, so the outage hint names a step the operator can take here. */
export function currentGatewayHost(): GatewayHost {
  if (typeof window === "undefined") return { desktopApp: false, hostname: "" };
  const embedded = Boolean((window as Window & { chrome?: { webview?: unknown } }).chrome?.webview);
  const desktopApp =
    embedded || window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost";
  let hostname = window.location.hostname;
  try {
    hostname = new URL(getGatewayApiBaseUrl(), window.location.href).hostname;
  } catch {
    // An unparsable base URL falls back to the page host.
  }
  return { desktopApp, hostname };
}

/** One sentence that tells the operator how to bring the Gateway back from where they are. */
export function gatewayStartHint(host: GatewayHost): string {
  if (host.desktopApp) return "Open the GoatCitadel desktop app and check that it is running.";
  if (SAME_MACHINE_HOSTS.has(host.hostname.toLowerCase()))
    return "Start GoatCitadel on this computer: open the desktop app or run goatcitadel up.";
  return "GoatCitadel runs on another computer. Check that it is running there and that this device can reach it.";
}
