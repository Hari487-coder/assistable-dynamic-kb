import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldKeepAlive, startKeepAlive } from "../src/keepalive.js";

const quietLogger = { info() {}, warn() {}, error() {} };

test("shouldKeepAlive: on by default on Render with an https URL", () => {
  assert.equal(shouldKeepAlive({ RENDER: "true" }, "https://x.onrender.com"), true);
});

test("shouldKeepAlive: off on Render when the base URL is local http", () => {
  assert.equal(shouldKeepAlive({ RENDER: "true" }, "http://localhost:3900"), false);
});

test("shouldKeepAlive: off when not on Render and not explicitly forced", () => {
  assert.equal(shouldKeepAlive({}, "https://kb.example.com"), false);
});

test("shouldKeepAlive: KEEP_AWAKE=1 forces on for any https host", () => {
  assert.equal(shouldKeepAlive({ KEEP_AWAKE: "1" }, "https://kb.example.com"), true);
  assert.equal(shouldKeepAlive({ KEEP_AWAKE: "1" }, "http://localhost:3900"), false);
});

test("shouldKeepAlive: KEEP_AWAKE=0 forces off even on Render", () => {
  assert.equal(shouldKeepAlive({ RENDER: "true", KEEP_AWAKE: "0" }, "https://x.onrender.com"), false);
});

test("startKeepAlive: disabled -> no-op stop, never pings", () => {
  let calls = 0;
  const ka = startKeepAlive({
    config: { baseUrl: "http://localhost:3900" },
    logger: quietLogger,
    env: {},
    fetchImpl: () => { calls++; return Promise.resolve({ status: 200 }); },
  });
  ka.stop();
  assert.equal(calls, 0);
});

test("startKeepAlive: enabled -> pings {baseUrl}/healthz on each tick, stop() halts it", async () => {
  const hits = [];
  const ka = startKeepAlive({
    config: { baseUrl: "https://x.onrender.com" },
    logger: quietLogger,
    env: { RENDER: "true" },
    fetchImpl: async (url) => { hits.push(url); return { status: 200 }; },
    intervalMs: 5,
  });
  await new Promise((r) => setTimeout(r, 24));
  ka.stop();
  const afterStop = hits.length;
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(afterStop >= 1, "expected at least one ping while running");
  assert.equal(hits[0], "https://x.onrender.com/healthz");
  assert.equal(hits.length, afterStop, "expected no pings after stop()");
});

test("startKeepAlive: a failing ping is swallowed, not thrown", async () => {
  let warned = 0;
  const ka = startKeepAlive({
    config: { baseUrl: "https://x.onrender.com" },
    logger: { ...quietLogger, warn() { warned++; } },
    env: { RENDER: "true" },
    fetchImpl: async () => { throw new Error("boom"); },
    intervalMs: 5,
  });
  await new Promise((r) => setTimeout(r, 14));
  ka.stop();
  assert.ok(warned >= 1, "expected the failure to be logged, not thrown");
});
