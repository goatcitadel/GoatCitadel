/**
 * Whether generated OpenUI blocks may render. Kept apart from the renderer so checking the flag never loads the
 * OpenUI parser and component library (the renderer is lazy-loaded only when the flag is on and a block appears).
 */
export function isGoatOpenUiRendererEnabled(): boolean {
  const globalFlag = globalThis.__GOATCITADEL_OPENUI_RENDERER__;
  if (globalFlag !== undefined) {
    return globalFlag === true || globalFlag === "true";
  }
  return import.meta.env.VITE_GOATCITADEL_OPENUI_RENDERER === "true";
}
