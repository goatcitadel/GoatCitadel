import path from "node:path";

export interface NativeDocumentParseResult {
  rawText: string;
  normalizedText: string;
  contentType: string;
  parser: {
    parserId: string;
    format: "text" | "pdf" | "docx" | "xlsx" | "csv";
    pageCount?: number;
    sheetNames?: string[];
    warnings?: string[];
  };
}

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".htm",
  ".log",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".dll",
  ".doc",
  ".exe",
  ".gif",
  ".gz",
  ".heic",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".odp",
  ".ods",
  ".odt",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".tar",
  ".tiff",
  ".webp",
  ".xls",
  ".zip",
]);

export async function parseNativeFileDocument(filePath: string, bytes: Buffer): Promise<NativeDocumentParseResult> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") {
    return parsePdf(bytes);
  }
  if (extension === ".docx") {
    return parseDocx(bytes);
  }
  if (extension === ".xlsx") {
    return parseXlsx(bytes);
  }
  if (extension === ".csv") {
    const rawText = decodeUtf8Text(bytes, filePath);
    return {
      rawText,
      normalizedText: rawText,
      contentType: "text/csv",
      parser: {
        parserId: "native-csv-text-v1",
        format: "csv",
      },
    };
  }
  if (TEXT_EXTENSIONS.has(extension) || (!extension && !looksBinary(bytes))) {
    const rawText = decodeUtf8Text(bytes, filePath);
    return {
      rawText,
      normalizedText: rawText,
      contentType: contentTypeForTextExtension(extension),
      parser: {
        parserId: "native-text-v1",
        format: "text",
      },
    };
  }
  if (BINARY_EXTENSIONS.has(extension) || looksBinary(bytes)) {
    throw new Error(`docs.ingest native backend cannot parse binary file format '${extension || "unknown"}'.`);
  }
  const rawText = decodeUtf8Text(bytes, filePath);
  return {
    rawText,
    normalizedText: rawText,
    contentType: "text/plain",
    parser: {
      parserId: "native-text-v1",
      format: "text",
    },
  };
}

async function parsePdf(bytes: Buffer): Promise<NativeDocumentParseResult> {
  const { extractText, getDocumentProxy } = (await importRuntimeModule("unpdf")) as {
    extractText: (
      pdf: { destroy: () => Promise<void> },
      options: { mergePages: true },
    ) => Promise<{ totalPages: number; text: string }>;
    getDocumentProxy: (data: Uint8Array) => Promise<{ destroy: () => Promise<void> }>;
  };
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const extracted = await extractText(pdf, { mergePages: true });
    return {
      rawText: extracted.text,
      normalizedText: extracted.text,
      contentType: "application/pdf",
      parser: {
        parserId: "unpdf-pdfjs-v1",
        format: "pdf",
        pageCount: extracted.totalPages,
      },
    };
  } finally {
    await pdf.destroy();
  }
}

async function parseDocx(bytes: Buffer): Promise<NativeDocumentParseResult> {
  const mammothModule = (await importRuntimeModule("mammoth")) as {
    default?: {
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string; messages: Array<{ message: string }> }>;
    };
    extractRawText?: (input: { buffer: Buffer }) => Promise<{ value: string; messages: Array<{ message: string }> }>;
  };
  const mammoth = mammothModule.default ?? mammothModule;
  if (!mammoth.extractRawText) {
    throw new Error("DOCX parser did not expose extractRawText.");
  }
  const extracted = await mammoth.extractRawText({ buffer: bytes });
  return {
    rawText: extracted.value,
    normalizedText: extracted.value,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    parser: {
      parserId: "mammoth-docx-v1",
      format: "docx",
      warnings: extracted.messages.map((message) => message.message).filter(Boolean),
    },
  };
}

async function parseXlsx(bytes: Buffer): Promise<NativeDocumentParseResult> {
  const XLSX = (await importRuntimeModule("@e965/xlsx")) as {
    read: (
      data: Buffer,
      options: { type: "buffer" },
    ) => {
      SheetNames: string[];
      Sheets: Record<string, unknown>;
    };
    utils: {
      sheet_to_csv: (sheet: unknown) => string;
    };
  };
  const workbook = XLSX.read(bytes, { type: "buffer" });
  const sections = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = sheet ? XLSX.utils.sheet_to_csv(sheet).trim() : "";
    return [`Sheet: ${sheetName}`, csv].filter(Boolean).join("\n");
  }).filter(Boolean);
  return {
    rawText: sections.join("\n\n"),
    normalizedText: sections.join("\n\n"),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    parser: {
      parserId: "sheetjs-xlsx-v1",
      format: "xlsx",
      sheetNames: workbook.SheetNames,
    },
  };
}

function decodeUtf8Text(bytes: Buffer, filePath: string): string {
  if (looksBinary(bytes)) {
    throw new Error(`docs.ingest native backend cannot parse binary file '${filePath}'.`);
  }
  return bytes.toString("utf8");
}

function looksBinary(bytes: Buffer): boolean {
  const sampleLength = Math.min(bytes.length, 4096);
  if (sampleLength === 0) {
    return false;
  }
  let suspicious = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index];
    if (byte === 0) {
      return true;
    }
    if (byte !== undefined && byte < 7) {
      suspicious += 1;
    }
  }
  return suspicious / sampleLength > 0.08;
}

function contentTypeForTextExtension(extension: string): string {
  if (extension === ".html" || extension === ".htm") {
    return "text/html";
  }
  if (extension === ".json" || extension === ".jsonl") {
    return "application/json";
  }
  if (extension === ".xml") {
    return "application/xml";
  }
  return "text/plain";
}

async function importRuntimeModule(specifier: string): Promise<unknown> {
  return import(specifier);
}
