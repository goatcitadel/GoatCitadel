export const LOCAL_PATH_TOOL_NAME_LIST = [
  "fs.read",
  "fs.list",
  "fs.stat",
  "fs.copy",
  "fs.write",
  "fs.move",
  "fs.delete",
  "file.read_range",
  "file.find",
  "code.search",
  "code.search_files",
] as const;

export const LOCAL_QUERY_TOOL_NAME_LIST = ["code.search", "code.search_files"] as const;

export const WEB_TOOL_NAME_LIST = [
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "browser.interact",
  "http.get",
  "http.post",
] as const;

export const MCP_BROWSER_FALLBACK_TOOL_NAME_LIST = [
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "http.get",
] as const;

export const PROMPT_PACK_FILE_TOOL_NAME_LIST = [
  "fs.read",
  "fs.list",
  "fs.stat",
  "file.read_range",
  "file.find",
  "code.search",
  "code.search_files",
] as const;

export const PROMPT_PACK_CODE_TOOL_NAME_LIST = [...PROMPT_PACK_FILE_TOOL_NAME_LIST, "tests.run", "lint.run"] as const;
export const PROMPT_PACK_WEB_TOOL_NAME_LIST = ["browser.search", "browser.navigate", "browser.extract"] as const;
export const PROMPT_PACK_MEMORY_TOOL_NAME_LIST = ["memory.read", "memory.search"] as const;

export const PROMPT_PACK_SAFE_EXPLICIT_TOOL_NAME_LIST = [
  "session.status",
  "time.now",
  "fs.read",
  "fs.list",
  "fs.stat",
  "file.read_range",
  "file.find",
  "code.search",
  "code.search_files",
  "http.get",
  "tests.run",
  "lint.run",
  "build.run",
  "git.status",
  "git.diff",
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "browser.screenshot",
  "citations.build",
  "memory.read",
  "memory.search",
  "embeddings.query",
] as const;

export const PROMPT_PACK_GATED_EXPLICIT_TOOL_NAME_LIST = [
  "fs.write",
  "artifacts.create",
  "shell.exec",
  "shell.exec_background",
  "git.exec",
  "http.post",
  "browser.interact",
  "browser.cookies.get",
  "browser.cookies.set",
  "browser.cookies.clear",
  "browser.storage.get",
  "browser.storage.set",
  "browser.storage.clear",
  "browser.context.configure",
  "memory.write",
  "memory.upsert",
  "docs.ingest",
  "embeddings.index",
] as const;

export const PROMPT_PACK_EXPLICIT_TOOL_NAME_LIST = [
  ...PROMPT_PACK_SAFE_EXPLICIT_TOOL_NAME_LIST,
  ...PROMPT_PACK_GATED_EXPLICIT_TOOL_NAME_LIST,
] as const;

export const PROMPT_PACK_WEB_LOOKUP_DIRECT_TOOL_NAME_LIST = [
  "browser.search",
  "browser.navigate",
  "browser.extract",
  "http.get",
] as const;

export const LOCAL_PATH_TOOL_NAMES = new Set<string>(LOCAL_PATH_TOOL_NAME_LIST);
export const LOCAL_QUERY_TOOL_NAMES = new Set<string>(LOCAL_QUERY_TOOL_NAME_LIST);
export const WEB_TOOL_NAMES = new Set<string>(WEB_TOOL_NAME_LIST);
export const MCP_BROWSER_FALLBACK_TOOL_NAMES = new Set<string>(MCP_BROWSER_FALLBACK_TOOL_NAME_LIST);
export const PROMPT_LAB_LOCAL_FILE_TOOL_NAMES = new Set<string>(LOCAL_PATH_TOOL_NAME_LIST);
export const PROMPT_PACK_WEB_LOOKUP_DIRECT_TOOL_NAMES = new Set<string>(PROMPT_PACK_WEB_LOOKUP_DIRECT_TOOL_NAME_LIST);
