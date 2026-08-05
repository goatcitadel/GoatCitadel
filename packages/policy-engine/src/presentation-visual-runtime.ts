import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import type { PresentationVisualAsset } from "./presentation-pptx.js";

export interface PresentationVisualPlanItem {
  slideIndex: number;
  slideTitle: string;
  kind: "cover" | "section";
  promptSha256: string;
  visualBrief?: string;
}

export interface PreparedPresentationVisual {
  slideIndex: number;
  asset: PresentationVisualAsset;
  promptSha256: string;
}

/** Ephemeral bytes plus persistence-safe plan/provenance returned after authorization. */
export interface PreparedPresentationVisuals {
  plan: PresentationVisualPlanItem[];
  assets: PreparedPresentationVisual[];
  warnings: string[];
  providerCalls: number;
}

export type PreparePresentationVisuals = (request: ToolInvokeRequest) => Promise<PreparedPresentationVisuals>;
