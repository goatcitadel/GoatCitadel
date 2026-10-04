import type { TestbenchEnv } from "../env";

export type TargetKind = "sandbox" | "real";

export interface TargetRequest {
  readonly requested: TargetKind;
  /** Origin forced through the gateway-origin meta tag; undefined keeps the client's default resolution. */
  readonly origin: string | undefined;
}

export const GATEWAY_ORIGIN_META_NAME = "goatcitadel-gateway-origin";

export function resolveTargetRequest(search: string, env: TestbenchEnv): TargetRequest {
  const param = new URLSearchParams(search).get("target");
  const requested: TargetKind =
    param === "sandbox" || param === "real" ? param : env.sandboxOrigin ? "sandbox" : "real";
  return { requested, origin: requested === "sandbox" ? env.sandboxOrigin : env.realOrigin };
}

export function applyGatewayOriginMeta(doc: Document, origin: string | undefined): void {
  for (const existing of Array.from(doc.querySelectorAll(`meta[name="${GATEWAY_ORIGIN_META_NAME}"]`))) {
    existing.remove();
  }
  if (!origin) {
    return;
  }
  const meta = doc.createElement("meta");
  meta.name = GATEWAY_ORIGIN_META_NAME;
  meta.content = origin;
  doc.head.append(meta);
}

export function buildTargetHref(currentHref: string, kind: TargetKind): string {
  const url = new URL(currentHref);
  url.searchParams.set("target", kind);
  return url.toString();
}
