import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { ensureSchema } from "./setup";

describe("GET /api/health", () => {
  it("returns ok status with file and chunk counts", async () => {
    await ensureSchema();
    const response = await SELF.fetch("http://localhost/api/health");
    expect(response.status).toBe(200);

    const data = await response.json<{
      status: string;
      version: string;
      indexed_files: number;
      total_chunks: number;
    }>();

    expect(data.status).toBe("ok");
    expect(data.version).toBe("1.0.0");
    expect(data.indexed_files).toBe(0);
    expect(data.total_chunks).toBe(0);
  });
});

describe("404 handling", () => {
  it("returns 404 for unknown routes", async () => {
    const response = await SELF.fetch("http://localhost/api/unknown");
    expect(response.status).toBe(404);

    const data = await response.json<{
      error: { code: string; message: string };
    }>();
    expect(data.error.code).toBe("NOT_FOUND");
  });
});
