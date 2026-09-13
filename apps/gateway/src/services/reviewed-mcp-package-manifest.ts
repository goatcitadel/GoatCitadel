/** Reviewed npm archives, including the complete transitive runtime closure.
 * File-tree hashes are independent of npm cache metadata and executable modes.
 * Updating any byte requires a new pack binding and operator review.
 */
export const REVIEWED_PLAYWRIGHT_PACKAGE = {
  schemaVersion: 1,
  packageSpec: "@playwright/mcp@0.0.80",
  entrypoint: "@playwright/mcp/cli.js",
  packages: [
    {
      name: "@playwright/mcp",
      version: "0.0.80",
      url: "https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.80.tgz",
      integrity: "sha512-FOPXHm2SvFhAQylm10jMZ35B/SR2TaMLVkavAlwoG4N2qCb5RqbvhQYcu3zmXNyxR2DW0Ooxe+9XPVt5UjKRCQ==",
      treeSha256: "250118552b36e7d45131f1acbca4793f4737841a23aa05ea6f203ce7560caaa7",
      files: 7,
      bytes: 86311,
    },
    {
      name: "playwright",
      version: "1.63.0-alpha-2026-08-31",
      url: "https://registry.npmjs.org/playwright/-/playwright-1.63.0-alpha-2026-08-31.tgz",
      integrity: "sha512-3XAsuznfu8jBVJ4QxdGvBkt0+b8ZFwuwJYyOfiIw5ZjUOrNLNRhKxzLzLuydou3gJ9c6eMwVqgzdiOwhy54Kzw==",
      treeSha256: "b1dc8c3620c120b571fb0f2e44a5918d307620eff960df9c2b775e7290fcce7f",
      files: 62,
      bytes: 5093378,
    },
    {
      name: "playwright-core",
      version: "1.63.0-alpha-2026-08-31",
      url: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0-alpha-2026-08-31.tgz",
      integrity: "sha512-1ek0Lyr12h6jcs/WTcNoVtzZkQp7D/90PsMuBW/Rm6h3AsWAbzpqj0geMv8+8Tzzr9CSUYvg9kznrVZINQMXXw==",
      treeSha256: "c51c2e528dd5c526d791b8af2c78def735b933d0f7780c8bdbfb51f5038b1589",
      files: 113,
      bytes: 13435142,
    },
  ],
} as const;
