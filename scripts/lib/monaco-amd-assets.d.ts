import type { Plugin } from "vite";
export declare const MONACO_PUBLIC_BASE = "/vendor/monaco/vs";
export declare function monacoAmdAssetsPlugin({ packageRoot }: {
    packageRoot: string;
}): Plugin;
