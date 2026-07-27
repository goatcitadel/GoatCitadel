export type NativeRouteErrorCategory = "authentication-required" | "gateway-unavailable" | "http" | "unknown";

export type NativeRouteErrorPresentation = {
  category: NativeRouteErrorCategory;
  title: string;
  description: string;
  technicalDetail?: string;
};

export type NativeRouteError = string | NativeRouteErrorPresentation;

export type NativeRouteErrorContext = {
  resourceLabel?: string;
  authenticationRequired?: boolean;
  authenticationDescription?: string;
  unavailableDescription?: string;
};

const MACHINE_ERROR_PATTERN = /(?:API error\s+\d+|Network error|fetch failed|failed to fetch|ECONNREFUSED)/i;
const AUTHENTICATION_ERROR_PATTERN =
  /(?:authenticated operator|operator authentication|specific authenticated operator|API error\s+(?:401|403))/i;
const NETWORK_ERROR_PATTERN = /(?:Network error|fetch failed|failed to fetch|ECONNREFUSED|gateway[^.]*unreachable)/i;
const HTTP_STATUS_PATTERN = /API error\s+(\d{3})/i;

export function isNativeRouteErrorPresentation(value: unknown): value is NativeRouteErrorPresentation {
  return (
    typeof value === "object" && value !== null && "category" in value && "title" in value && "description" in value
  );
}

export function presentNativeRouteError(
  error: string,
  context: NativeRouteErrorContext = {},
): NativeRouteErrorPresentation {
  const technicalDetail = error.trim() || "No technical detail was returned.";
  const resourceLabel = context.resourceLabel?.trim() || "This section";

  if (context.authenticationRequired || AUTHENTICATION_ERROR_PATTERN.test(technicalDetail)) {
    return {
      category: "authentication-required",
      title: "Operator authentication required",
      description:
        context.authenticationDescription ??
        `${resourceLabel} requires an authenticated token, basic-auth, or trusted loopback operator route. Configure operator access, then retry.`,
      technicalDetail,
    };
  }

  if (NETWORK_ERROR_PATTERN.test(technicalDetail)) {
    return {
      category: "gateway-unavailable",
      title: `${resourceLabel} unavailable`,
      description:
        context.unavailableDescription ??
        `Mission Control could not reach the Gateway for ${resourceLabel.toLowerCase()}. Check runtime health, then retry.`,
      technicalDetail,
    };
  }

  const status = HTTP_STATUS_PATTERN.exec(technicalDetail)?.[1];
  if (status) {
    return {
      category: "http",
      title: `${resourceLabel} could not load`,
      description: `The Gateway rejected the request with status ${status}. Retry or inspect the technical details.`,
      technicalDetail,
    };
  }

  if (!MACHINE_ERROR_PATTERN.test(technicalDetail)) {
    return {
      category: "unknown",
      title: `${resourceLabel} could not load`,
      description: technicalDetail,
    };
  }

  return {
    category: "unknown",
    title: `${resourceLabel} could not load`,
    description: "Mission Control could not complete this request. Retry or inspect the technical details.",
    technicalDetail,
  };
}

export function normalizeNativeRouteError(
  error: NativeRouteError,
  context: NativeRouteErrorContext = {},
): NativeRouteErrorPresentation {
  return isNativeRouteErrorPresentation(error) ? error : presentNativeRouteError(error, context);
}
