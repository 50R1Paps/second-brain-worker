export interface IngestPayload {
  file_key: string;
  content: string;
  file_type: "wiki_page" | "ingested";
  title?: string;
  source?: string;
}

export interface IngestResponse {
  file_key: string;
  chunk_count: number;
  status: string;
}

export interface SetupResult {
  file_key: string;
  success: boolean;
  chunk_count?: number;
  error?: string;
  attempts: number;
}

export interface SetupSummary {
  total: number;
  succeeded: number;
  failed: number;
  total_chunks: number;
  results: SetupResult[];
  duration_ms: number;
}

export type IngestFetch = (
  url: string,
  options: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const DEFAULT_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export function createIngestPayload(
  relativePath: string,
  content: string,
): IngestPayload {
  const fileKey = relativePath.startsWith("wiki/")
    ? relativePath
    : `wiki/${relativePath}`;
  const title = extractTitle(content) ?? extractTitleFromPath(relativePath);
  return {
    file_key: fileKey,
    content,
    file_type: "wiki_page",
    title,
    source: fileKey,
  };
}

function extractTitle(content: string): string | undefined {
  const fmMatch = content.match(/^---\n[\s\S]*?^title:\s*(.+)$/m);
  if (fmMatch) return fmMatch[1].trim().replace(/^["']|["']$/g, "");
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return undefined;
}

function extractTitleFromPath(path: string): string {
  const basename = path.split("/").pop() ?? path;
  return basename.replace(/\.md$/i, "");
}

export async function ingestWithRetry(
  fetchFn: IngestFetch,
  url: string,
  payload: IngestPayload,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<SetupResult> {
  let lastError: string | undefined;
  const body = JSON.stringify(payload);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (response.ok) {
        const data = (await response.json()) as IngestResponse;
        return {
          file_key: payload.file_key,
          success: true,
          chunk_count: data.chunk_count,
          attempts: attempt,
        };
      }

      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Unknown error";
    }

    if (attempt < maxRetries) {
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  return {
    file_key: payload.file_key,
    success: false,
    error: lastError,
    attempts: maxRetries,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatProgress(
  current: number,
  total: number,
  fileName: string,
): string {
  const width = 30;
  const filled = Math.round((current / total) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const percent = Math.round((current / total) * 100);
  const display = fileName.length > 40 ? "..." + fileName.slice(-37) : fileName;
  return `\r[${bar}] ${percent}% (${current}/${total}) ${display}`;
}

export function formatSummary(summary: SetupSummary): string {
  const lines: string[] = [
    "",
    "─".repeat(50),
    "Setup complete",
    "─".repeat(50),
    `  Total files:   ${summary.total}`,
    `  Succeeded:     ${summary.succeeded}`,
    `  Failed:        ${summary.failed}`,
    `  Total chunks:  ${summary.total_chunks}`,
    `  Duration:      ${(summary.duration_ms / 1000).toFixed(1)}s`,
  ];

  if (summary.failed > 0) {
    lines.push("", "Failed files:");
    for (const r of summary.results.filter((r) => !r.success)) {
      lines.push(`  ✗ ${r.file_key} (${r.error})`);
    }
  }

  lines.push("─".repeat(50));
  return lines.join("\n");
}
