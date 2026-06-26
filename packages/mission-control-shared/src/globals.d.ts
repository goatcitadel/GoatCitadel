declare global {
  interface ImportMetaEnv {
    readonly DEV?: boolean;
    readonly MODE?: string;
    readonly VITE_GATEWAY_URL?: string;
    readonly VITE_GATEWAY_ALLOWED_HOSTS?: string;
    readonly VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED?: string;
    readonly VITE_GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE?: string;
    readonly VITE_GOATCITADEL_VISUAL_REGRESSION_MODE?: string;
    readonly VITE_GOATCITADEL_OPENUI_RENDERER?: string;
    readonly [key: string]: string | boolean | undefined;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  var __GOATCITADEL_OPENUI_RENDERER__: boolean | string | undefined;
}

export {};
