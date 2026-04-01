import { FOLLOW_ON_PROOF_LANE_SPECS, type FollowOnProofLaneDraftId, type FollowOnProofLaneSpec } from "@goatcitadel/contracts";

interface GatewayFollowOnProofLaneSpec extends FollowOnProofLaneSpec {
  artifactRoot: string;
}

export const GATEWAY_FOLLOW_ON_PROOF_LANE_SPECS: Record<FollowOnProofLaneDraftId, GatewayFollowOnProofLaneSpec> = {
  browser: {
    ...FOLLOW_ON_PROOF_LANE_SPECS.browser,
    artifactRoot: "artifacts/follow-on-parity/browser",
  },
  packaging: {
    ...FOLLOW_ON_PROOF_LANE_SPECS.packaging,
    artifactRoot: "artifacts/follow-on-parity/packaging",
  },
  a2ui: {
    ...FOLLOW_ON_PROOF_LANE_SPECS.a2ui,
    artifactRoot: "artifacts/follow-on-parity/a2ui",
  },
  voice: {
    ...FOLLOW_ON_PROOF_LANE_SPECS.voice,
    artifactRoot: "artifacts/follow-on-parity/voice",
  },
};
