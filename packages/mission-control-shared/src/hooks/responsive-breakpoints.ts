/** Matches Tailwind sm/lg/xl/2xl. Range predicates are exact inverses, including fractional CSS pixels. */
export const RESPONSIVE_BREAKPOINTS = { phone: 640, desktop: 1024, wide: 1280, large: 1600 } as const;
export const RESPONSIVE_QUERIES = {
  phone: `(width < ${RESPONSIVE_BREAKPOINTS.phone}px)`,
  abovePhone: `(width >= ${RESPONSIVE_BREAKPOINTS.phone}px)`,
  tablet: `(${RESPONSIVE_BREAKPOINTS.phone}px <= width < ${RESPONSIVE_BREAKPOINTS.desktop}px)`,
  belowDesktop: `(width < ${RESPONSIVE_BREAKPOINTS.desktop}px)`,
} as const;
