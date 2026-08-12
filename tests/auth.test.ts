import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAuthMiddleware } from "../src/server/auth.js";

function mockReq(header?: string) {
  return { header: (name: string) => (name.toLowerCase() === "authorization" ? header : undefined) } as any;
}

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

describe("createAuthMiddleware", () => {
  it("is a no-op when no token is configured", () => {
    const mw = createAuthMiddleware(undefined);
    let called = false;
    mw(mockReq(), mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  it("passes through a request with the correct bearer token", () => {
    const mw = createAuthMiddleware("secret-123");
    let called = false;
    mw(mockReq("Bearer secret-123"), mockRes(), () => { called = true; });
    assert.equal(called, true);
  });

  it("rejects a missing Authorization header with 401", () => {
    const mw = createAuthMiddleware("secret-123");
    const res = mockRes();
    let called = false;
    mw(mockReq(), res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: "unauthorized" });
  });

  it("rejects the wrong token with 401", () => {
    const mw = createAuthMiddleware("secret-123");
    const res = mockRes();
    let called = false;
    mw(mockReq("Bearer wrong"), res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
  });

  it("rejects a token of different length without throwing", () => {
    // timingSafeEqual throws on mismatched buffer lengths if compared
    // directly — this is exactly the attacker-controlled input that would
    // hit that path, so it must go through the hash-first comparison.
    const mw = createAuthMiddleware("secret-123");
    const res = mockRes();
    assert.doesNotThrow(() => mw(mockReq("Bearer x"), res, () => {}));
    assert.equal(res.statusCode, 401);
  });

  it("rejects a malformed Authorization header (no Bearer prefix)", () => {
    const mw = createAuthMiddleware("secret-123");
    const res = mockRes();
    mw(mockReq("secret-123"), res, () => {});
    assert.equal(res.statusCode, 401);
  });

  it("rejects an empty presented token even against an empty configured token check path", () => {
    const mw = createAuthMiddleware("secret-123");
    const res = mockRes();
    mw(mockReq("Bearer "), res, () => {});
    assert.equal(res.statusCode, 401);
  });
});
