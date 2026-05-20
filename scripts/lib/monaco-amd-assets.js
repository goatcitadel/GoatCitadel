"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MONACO_PUBLIC_BASE = void 0;
exports.monacoAmdAssetsPlugin = monacoAmdAssetsPlugin;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:stream/promises");
exports.MONACO_PUBLIC_BASE = "/vendor/monaco/vs";
const CONTENT_TYPES = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".map", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".ttf", "font/ttf"],
    [".txt", "text/plain; charset=utf-8"],
    [".woff", "font/woff"],
    [".woff2", "font/woff2"],
]);
function getContentType(filePath) {
    return CONTENT_TYPES.get(node_path_1.default.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}
function streamMonacoAsset(res, assetPath) {
    void (0, promises_1.pipeline)(node_fs_1.default.createReadStream(assetPath), res).catch((error) => {
        if (res.destroyed) {
            return;
        }
        if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
            return;
        }
        res.destroy(error instanceof Error ? error : undefined);
    });
}
function copyDirectory(sourceDir, targetDir) {
    node_fs_1.default.mkdirSync(targetDir, { recursive: true });
    for (const entry of node_fs_1.default.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = node_path_1.default.join(sourceDir, entry.name);
        const targetPath = node_path_1.default.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            copyDirectory(sourcePath, targetPath);
            continue;
        }
        node_fs_1.default.copyFileSync(sourcePath, targetPath);
    }
}
function resolveMonacoVsDirectory(packageRoot) {
    const candidateDirectories = [
        node_path_1.default.resolve(packageRoot, "node_modules/monaco-editor/min/vs"),
        node_path_1.default.resolve(packageRoot, "../../node_modules/monaco-editor/min/vs"),
    ];
    for (const candidate of candidateDirectories) {
        if (node_fs_1.default.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`Unable to resolve Monaco AMD assets for ${packageRoot}.`);
}
function sanitizeRelativeAssetPath(requestPath) {
    return requestPath
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean)
        .join("/");
}
function monacoAmdAssetsPlugin({ packageRoot }) {
    const sourceDir = resolveMonacoVsDirectory(packageRoot);
    let viteConfig = null;
    return {
        name: "goatcitadel-monaco-amd-assets",
        configResolved(config) {
            viteConfig = config;
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const requestUrl = req.url?.split("?")[0] ?? "";
                if (!requestUrl.startsWith(`${exports.MONACO_PUBLIC_BASE}/`)) {
                    next();
                    return;
                }
                const relativeAssetPath = sanitizeRelativeAssetPath(requestUrl.slice(exports.MONACO_PUBLIC_BASE.length));
                const resolvedAssetPath = node_path_1.default.resolve(sourceDir, `.${node_path_1.default.sep}${relativeAssetPath}`);
                if (!resolvedAssetPath.startsWith(sourceDir) || !node_fs_1.default.existsSync(resolvedAssetPath) || !node_fs_1.default.statSync(resolvedAssetPath).isFile()) {
                    res.statusCode = 404;
                    res.end();
                    return;
                }
                res.setHeader("Content-Type", getContentType(resolvedAssetPath));
                streamMonacoAsset(res, resolvedAssetPath);
            });
        },
        writeBundle() {
            if (!viteConfig) {
                return;
            }
            const outputDir = node_path_1.default.resolve(viteConfig.root, viteConfig.build.outDir);
            const targetDir = node_path_1.default.join(outputDir, "vendor", "monaco", "vs");
            copyDirectory(sourceDir, targetDir);
        },
    };
}
//# sourceMappingURL=monaco-amd-assets.js.map
