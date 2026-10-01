import { createContext, useContext } from "react";

export interface CockpitNavigationOptions {
  replace?: boolean;
}

/** This capability is issued only after the existing draft-leave owner accepts the transition. */
export interface ReviewedCockpitTransition {
  isCurrent: () => boolean;
  signal: AbortSignal;
  navigate: (href: string, options?: CockpitNavigationOptions) => boolean;
}

export interface CockpitNavigationOwner {
  isTransitionPending: () => boolean;
  navigate: (href: string, options?: CockpitNavigationOptions) => void;
  requestTransition: (action: (review: ReviewedCockpitTransition) => Promise<unknown> | void) => void;
}

export const CockpitNavigationContext = createContext<CockpitNavigationOwner | null>(null);

// A missing provider cannot silently bypass the leave review. Route reading remains available.
const unavailable: CockpitNavigationOwner = {
  isTransitionPending: () => true,
  navigate: () => undefined,
  requestTransition: () => undefined,
};

export function useCockpitNavigation(): CockpitNavigationOwner {
  return useContext(CockpitNavigationContext) ?? unavailable;
}
