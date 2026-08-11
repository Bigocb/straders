import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/engine/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "st-chat-"));
  const store = new Store(join(dir, "test.db"));
  (store as any).__dir = dir;
  return store;
}

describe("Store chat history", () => {
  it("persists and returns chat messages oldest-first", () => {
    const store = tempStore();
    try {
      store.recordChatMessage({ role: "user", content: "hello" });
      store.recordChatMessage({ role: "assistant", content: "hi captain" });
      const history = store.chatHistory();
      assert.equal(history.length, 2);
      assert.equal(history[0]?.role, "user");
      assert.equal(history[0]?.content, "hello");
      assert.equal(history[1]?.role, "assistant");
      assert.equal(history[1]?.content, "hi captain");
    } finally {
      store.close();
      rmSync((store as any).__dir, { recursive: true, force: true });
    }
  });

  it("respects the limit", () => {
    const store = tempStore();
    try {
      for (let i = 0; i < 5; i += 1) store.recordChatMessage({ role: "user", content: `m${i}` });
      const history = store.chatHistory(3);
      assert.equal(history.length, 3);
      assert.equal(history[0]?.content, "m2");
      assert.equal(history[2]?.content, "m4");
    } finally {
      store.close();
      rmSync((store as any).__dir, { recursive: true, force: true });
    }
  });
});
