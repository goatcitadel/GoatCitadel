import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const onboardingRouteMethods = [
  "bootstrapOnboarding",
  "getOnboardingStartupState",
  "getOnboardingState",
  "markOnboardingComplete",
] as const;

export type OnboardingRouteMethod = (typeof onboardingRouteMethods)[number];
export type OnboardingRoutePort = RoutePort<OnboardingRouteMethod>;
export type OnboardingRouteService = RouteService<OnboardingRouteMethod>;

export function createOnboardingRouteService(port: OnboardingRoutePort): OnboardingRouteService {
  return createRouteService(port, onboardingRouteMethods);
}
