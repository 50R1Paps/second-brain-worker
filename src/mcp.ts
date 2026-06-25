import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./handlers";
import {
  retrieveCore,
  ingestCore,
  validateIngestRequest,
  type IngestRequest,
  type RetrieveRequest,
} from "./handlers";
import type { Props } from "./oauth-utils";

const ALLOWED_USERNAMES = new Set<string>([]);

export class SecondBrainMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "Second Brain",
    version: "1.0.0",
  });

  async init() {
    if (ALLOWED_USERNAMES.size > 0 && !ALLOWED_USERNAMES.has(this.props!.login)) {
      return;
    }

    this.server.tool(
      "retrieve",
      "Search the Second Brain knowledge base using hybrid retrieval (semantic + keyword). Returns relevant chunks from indexed wiki pages and files.",
      {
        query: z
          .string()
          .describe("The search query — natural language or keywords."),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum number of results to return."),
        file_type: z
          .enum(["wiki_page", "ingested"])
          .optional()
          .describe("Filter results by file type."),
        section_prefix: z
          .string()
          .optional()
          .describe("Filter results to sections starting with this prefix."),
        file_key_prefix: z
          .string()
          .optional()
          .describe("Filter results to file keys starting with this prefix."),
      },
      async (params) => {
        const retrieveReq: RetrieveRequest = {
          query: params.query,
          limit: params.limit,
          filter: {
            file_type: params.file_type,
            section_prefix: params.section_prefix,
            file_key_prefix: params.file_key_prefix,
          },
        };

        const result = await retrieveCore(this.env, retrieveReq);

        const formatted = result.results
          .map((r, i) => {
            const lines = [
              `## Result ${i + 1} (score: ${r.score.toFixed(3)}, type: ${r.search_type})`,
              `**File:** ${r.file_key}`,
              r.title ? `**Title:** ${r.title}` : "",
              r.section ? `**Section:** ${r.section}` : "",
              "",
              r.content,
            ].filter(Boolean);
            return lines.join("\n");
          })
          .join("\n\n---\n\n");

        return {
          content: [
            {
              type: "text",
              text:
                formatted ||
                `No results found for query "${params.query}". Total matches: ${result.total}`,
            },
          ],
        };
      },
    );

    this.server.tool(
      "ingest",
      "Ingest a file into the Second Brain knowledge base. The file content is chunked, embedded, and stored in R2, D1, and Vectorize.",
      {
        file_key: z
          .string()
          .describe(
            "Unique identifier for the file. For wiki pages: relative path (e.g. 'wiki/concepts/Tool Attention.md'). For external files: 'filename:uuid'.",
          ),
        content: z.string().describe("The full text content of the file to ingest."),
        file_type: z
          .enum(["wiki_page", "ingested"])
          .describe("The type of file being ingested."),
        title: z
          .string()
          .optional()
          .describe("Optional title for the file."),
        source: z
          .string()
          .optional()
          .describe("Optional source URL or path for the file."),
      },
      async (params) => {
        const ingestReq: IngestRequest = {
          file_key: params.file_key,
          content: params.content,
          file_type: params.file_type,
          title: params.title,
          source: params.source,
        };

        const validated = validateIngestRequest(ingestReq);
        if (!validated) {
          return {
            content: [
              {
                type: "text",
                text: "Validation error: file_key, content, and file_type are required.",
              },
            ],
            isError: true,
          };
        }

        const result = await ingestCore(this.env, validated);

        if (result instanceof Response) {
          const body = await result.json();
          return {
            content: [{ type: "text", text: JSON.stringify(body) }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Ingested ${result.file_key}: ${result.chunk_count} chunks, status: ${result.status}`,
            },
          ],
        };
      },
    );

    this.server.tool(
      "reindex",
      "Re-index a specific file or all files in the Second Brain. Reads raw content from R2 and re-runs chunking + embedding.",
      {
        file_key: z
          .string()
          .optional()
          .describe(
            "The file key to reindex. If omitted, all files are reindexed.",
          ),
      },
      async (params) => {
        if (params.file_key) {
          const file = await this.env.DB.prepare(
            "SELECT file_key, file_type, r2_key FROM files WHERE file_key = ?",
          )
            .bind(params.file_key)
            .first<{ file_key: string; file_type: string; r2_key: string }>();

          if (!file) {
            return {
              content: [
                {
                  type: "text",
                  text: `File ${params.file_key} not found.`,
                },
              ],
              isError: true,
            };
          }

          const r2Obj = await this.env.RAW_BUCKET.get(file.r2_key);
          if (!r2Obj) {
            return {
              content: [
                {
                  type: "text",
                  text: `Raw content for ${params.file_key} not found in R2.`,
                },
              ],
              isError: true,
            };
          }

          const content = await r2Obj.text();
          const result = await ingestCore(this.env, {
            file_key: file.file_key,
            content,
            file_type: file.file_type as "wiki_page" | "ingested",
          });

          if (result instanceof Response) {
            const body = await result.json();
            return {
              content: [{ type: "text", text: JSON.stringify(body) }],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Reindexed ${params.file_key}: ${result.chunk_count} chunks`,
              },
            ],
          };
        }

        const files = await this.env.DB.prepare(
          "SELECT file_key, file_type, r2_key FROM files",
        ).all<{ file_key: string; file_type: string; r2_key: string }>();

        let count = 0;
        for (const file of files.results) {
          const r2Obj = await this.env.RAW_BUCKET.get(file.r2_key);
          if (!r2Obj) continue;
          const content = await r2Obj.text();
          const result = await ingestCore(this.env, {
            file_key: file.file_key,
            content,
            file_type: file.file_type as "wiki_page" | "ingested",
          });
          if (!(result instanceof Response)) count++;
        }

        return {
          content: [
            {
              type: "text",
              text: `Reindexed ${count} file(s).`,
            },
          ],
        };
      },
    );
  }
}
