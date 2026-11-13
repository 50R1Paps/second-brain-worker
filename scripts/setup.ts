import { constants, openSync, closeSync, fstatSync, readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createIngestPayload,
  ingestWithRetry,
  formatProgress,
  formatSummary,
} from "../src/setup";
import type { SetupResult, SetupSummary, IngestFetch } from "../src/setup";
import { MAX_FILE_BYTES } from "../src/request-security";

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
    dryRun: true,
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
      case "--publish":
        args.dryRun = false;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.maxRetries) || args.maxRetries < 1 || args.maxRetries > 3) throw new Error("Retries must be between 1 and 3");
  const destination = new URL(args.workerUrl);
  if (destination.username || destination.password || destination.search || destination.hash ||
      (destination.protocol !== "https:" && !(destination.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname)))) {
    throw new Error("Worker URL must use HTTPS or a literal local HTTP endpoint");
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
      --dry-run            Scan and list files (default)
      --publish            Explicitly publish the bounded scan
  -h, --help               Show this help

Environment:
  SECOND_BRAIN_API_TOKEN   Bearer token for the Worker REST API (required unless --dry-run)
`);
}

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  const absoluteDir = resolve(dir);
  const root = realpathSync(absoluteDir);
  if (root !== absoluteDir || lstatSync(absoluteDir).isSymbolicLink()) throw new Error("Wiki root must not contain symlinks");

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${fullPath}`);
      const real = realpathSync(fullPath);
      const rel = relative(root, real);
      if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("Path escapes wiki root");
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith(".md")) {
        if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds size limit: ${fullPath}`);
        if (results.length >= 1000) throw new Error("Scan exceeds 1000 files");
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
    return process.exit(1);
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

  const apiToken = process.env.SECOND_BRAIN_API_TOKEN;
  if (!apiToken) {
    console.error("SECOND_BRAIN_API_TOKEN is not set.");
    process.exit(1);
  }

  const ingestUrl = `${args.workerUrl}/api/ingest`;
  const fetchFn: IngestFetch = async (url, options) => {
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${apiToken}` },
    });
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
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let content: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || lstatSync(file).isSymbolicLink() || realpathSync(file) !== file)
        throw new Error("File changed or is outside the wiki root");
      content = readFileSync(fd, "utf-8");
      if (Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
    } finally {
      closeSync(fd);
    }
    const relPath = relative(wikiDir, file).split(sep).join("/");
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
