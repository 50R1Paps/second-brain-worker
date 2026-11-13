import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { readBodyBounded, RequestBodyError } from "../src/http";
import { guardIngress, checkPrincipalLimit } from "../src/request-security";
import type { Env } from "../src/types";
import { ensureSchema } from "./setup";

const bindings = env as unknown as Env;
const allow = { limit: async () => ({ success: true }) } as RateLimit;
const deny = { limit: async () => ({ success: false }) } as RateLimit;

async function bodyErrorStatus(request: Request, maxBytes: number): Promise<number> {
  try {
    await readBodyBounded(request, maxBytes);
    throw new Error("The oversized or encoded body was accepted");
  } catch (error) {
    if (!(error instanceof RequestBodyError)) throw error;
    return error.response.status;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("bounded raw request bodies", () => {
  it("rejects streamed bytes beyond the cap even when Content-Length understates them", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abc"));
        controller.enqueue(new TextEncoder().encode("def"));
        controller.close();
      },
    });
    const request = new Request("https://localhost/api/ingest", {
      method: "POST", headers: { "Content-Length": "1" }, body,
    });
    expect(await bodyErrorStatus(request, 5)).toBe(413);
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    const request = new Request("https://localhost/api/ingest", {
      method: "POST", body: "ééé",
    });
    expect(await bodyErrorStatus(request, 5)).toBe(413);
  });

  it("rejects compressed payloads before downstream parsers", async () => {
    const request = new Request("https://localhost/register", {
      method: "POST", headers: { "Content-Encoding": "gzip" }, body: "compressed",
    });
    expect(await bodyErrorStatus(request, 1024)).toBe(415);
  });

  it("preserves the signed request bytes exactly when below the cap", async () => {
    const content = '{ "message": "caffè", "items": [1, 2] }\n';
    const request = new Request("https://localhost/webhook/github", {
      method: "POST", body: content,
    });
    const result = await guardIngress(request, {
      ...bindings, AUTH_RATE_LIMITER: allow, REQUEST_RATE_LIMITER: allow,
    });
    expect(result).toBeInstanceOf(Request);
    expect(await (result as Request).text()).toBe(content);
  });
});

describe("request admission budgets", () => {
  it("denies before the OAuth handler when the ingress allowance is exhausted", async () => {
    const result = await guardIngress(new Request("https://localhost/register", {
      method: "POST", body: "{}",
    }), { ...bindings, AUTH_RATE_LIMITER: deny });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(429);
    expect((result as Response).headers.get("Retry-After")).toBe("60");
  });

  it("denies new registrations after the atomic daily storage budget is exhausted", async () => {
    await ensureSchema();
    const now = Date.parse("2026-11-13T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const day = Math.floor(now / 86_400_000);
    await bindings.DB.prepare(
      "INSERT INTO request_counters (bucket, count, expires_at) VALUES (?, 100, ?)",
    ).bind(`registration:${day}`, (day + 2) * 86_400).run();
    const result = await guardIngress(new Request("https://localhost/register", {
      method: "POST", body: "{}",
    }), { ...bindings, AUTH_RATE_LIMITER: allow });
    expect((result as Response).status).toBe(429);
    const row = await bindings.DB.prepare("SELECT count FROM request_counters WHERE bucket = ?")
      .bind(`registration:${day}`).first<{ count: number }>();
    expect(row?.count).toBe(100);
  });

  it("denies authenticated tool traffic after the principal allowance is exhausted", async () => {
    const response = await checkPrincipalLimit({ ...bindings, REQUEST_RATE_LIMITER: deny }, "owner:57759605");
    expect(response?.status).toBe(429);
  });
});
