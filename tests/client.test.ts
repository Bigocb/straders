import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "../src/core/client.js";

describe("Client", () => {
  it("extracts structured error from API response", async () => {
    const client = new Client({ baseUrl: "http://localhost:1", maxRetries: 0 });
    // Simulate an error response by monkey-patching global fetch.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { message: "Ship not found", code: "SHIP_NOT_FOUND" } }), {
        status: 404,
        statusText: "Not Found",
      });
    try {
      await client.request({ method: "GET", path: "/" });
      assert.fail("expected error");
    } catch (err: any) {
      assert.equal(err.name, "APIError");
      assert.equal(err.status, 404);
      assert.equal(err.code, "SHIP_NOT_FOUND");
      assert.match(err.message, /Ship not found/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries on 500 then succeeds", async () => {
    const client = new Client({ baseUrl: "http://localhost:1", maxRetries: 2, retryBackoffMs: 1 });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
      }
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, statusText: "OK" });
    };
    const res = await client.get("/");
    assert.deepEqual(res, { ok: true });
    assert.equal(calls, 2);
    globalThis.fetch = originalFetch;
  });

  it("rate-limits by acquiring a token bucket", async () => {
    const client = new Client({ baseUrl: "http://localhost:1" });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: { n: calls } }), { status: 200 });
    };
    const t0 = Date.now();
    await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
    const elapsed = Date.now() - t0;
    assert.equal(calls, 3);
    // With a 2/sec rate and burst 30, 3 calls should resolve quickly but not instantly.
    assert.ok(elapsed < 1000, "burst should allow 3 calls quickly");
    globalThis.fetch = originalFetch;
  });
});
