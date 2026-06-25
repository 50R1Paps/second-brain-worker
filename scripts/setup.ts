import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  createIngestPayload,
  ingestWithRetry,
  formatProgress,
  formatSummary,
  type SetupResult,
  type SetupSummary,
  type IngestFetch,
} from "../src/setup";

const DEFAULT_WIKI_DIR = "wiki";
const DEFAULT_WORKER_URL = "http://localhost:8787";
const MAX_RETRIES = 3;

interface CliArgs {
  wikiDir: string;
  workerUrl: string;
  maxRetries: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    wikiDir: DEFAULT_WIKI_DIR,
    workerUrl: DEFAULT_WORKER_URL,
    maxRetries: MAX_RETRIES,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--wiki-dir":
      case "-d":
        args.wikiDir = argv[++i] ?? args.wikiDir;
        break;
      case "--url":
      case "-u":
        args.workerUrl = argv[++i] ?? args.workerUrl;
        break;
      case "--max-retries":
        args.maxRetries = parseInt(argv[++i] ?? "3", 10);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
Usage: npx tsx scripts/setup.ts [options]

Options:
  -d, --wiki-dir <path>    Path to wiki directory (default: wiki)
  -u, --url <url>          Worker URL (default: http://localhost:8787)
      --max-retries <n>    Max retries per file (default: 3)
      --dry-run            Scan and list files without ingesting
  -h, --help               Show this help
`);
}

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  const absoluteDir = resolve(dir);

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }

  walk(absoluteDir);
  return results.sort();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const wikiDir = resolve(args.wikiDir);

  console.log(`\nSecond Brain — Setup Script`);
  console.log(`  Wiki dir:  ${wikiDir}`);
  console.log(`  Worker URL: ${args.workerUrl}`);
  console.log(`  Retries:    ${args.maxRetries}`);
  console.log();

  let files: string[];
  try {
    files = findMarkdownFiles(wikiDir);
  } catch (err) {
    console.error(
      `Error scanning wiki directory: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  if (files.length === 0) {
    console.log("No .md files found in wiki directory.");
    process.exit(0);
  }

  console.log(`Found ${files.length} markdown files.\n`);

  if (args.dryRun) {
    for (const file of files) {
      const rel = relative(wikiDir, file);
      console.log(`  ${rel}`);
    }
    console.log(`\nDry run complete. ${files.length} files would be ingested.`);
    process.exit(0);
  }

  const ingestUrl = `${args.workerUrl}/api/ingest`;
  const fetchFn: IngestFetch = async (url, options) => {
    const response = await fetch(url, options as RequestInit);
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json(),
    };
  };

  const startTime = Date.now();
  const results: SetupResult[] = [];
  let totalChunks = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const relPath = relative(wikiDir, file).split(sep).join("/");
    const content = readFileSync(file, "utf-8");
    const payload = createIngestPayload(relPath, content);

    process.stdout.write(formatProgress(i, files.length, relPath));

    const result = await ingestWithRetry(
      fetchFn,
      ingestUrl,
      payload,
      args.maxRetries,
    );

    results.push(result);
    if (result.success && result.chunk_count) {
      totalChunks += result.chunk_count;
    }

    process.stdout.write(
      formatProgress(i + 1, files.length, relPath) +
        (result.success ? " ✓" : " ✗") +
        "\n",
    );
  }

  const summary: SetupSummary = {
    total: files.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    total_chunks: totalChunks,
    results,
    duration_ms: Date.now() - startTime,
  };

  console.log(formatSummary(summary));

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
