import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { ensureSchema } from "./setup";
import { ingestCore } from "../src/ingest";
import { grepCore } from "../src/grep";
import type { Env } from "../src/types";

const bindings = env as unknown as Env;

describe("bounded RE2 grep", () => {
  it("finds matches and rejects unsupported backreferences and oversized patterns", async () => {
    await ensureSchema();
    await ingestCore(bindings, { file_key: "grep-re2", content: "alpha 42 beta 73", file_type: "ingested", push_to_github: false });
    const result = await grepCore(bindings, "grep-re2", "[0-9]+");
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) expect(result.matches.map(m => m.match)).toEqual(["42", "73"]);
    expect((await grepCore(bindings, "grep-re2", "(a)\\1") as Response).status).toBe(400);
    expect((await grepCore(bindings, "grep-re2", "x".repeat(513)) as Response).status).toBe(400);
  });
});
