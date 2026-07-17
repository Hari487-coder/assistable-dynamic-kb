import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, newSecret, constantTimeEqual, sha256Hex } from "../src/crypto.js";

const KEY = Buffer.alloc(32, 9).toString("base64");

test("round trip", () => {
  const blob = encryptSecret("sk-live-abc", KEY);
  assert.match(blob, /^v1:/);
  assert.equal(decryptSecret(blob, KEY), "sk-live-abc");
});

test("unique IVs", () => {
  assert.notEqual(encryptSecret("x", KEY), encryptSecret("x", KEY));
});

test("tamper detection", () => {
  const parts = encryptSecret("x", KEY).split(":");
  parts[2] = Buffer.from("evil").toString("base64");
  assert.throws(() => decryptSecret(parts.join(":"), KEY));
});

test("constantTimeEqual handles length mismatch without throwing", () => {
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("same", "same"), true);
});

test("newSecret is 43 chars base64url and unique", () => {
  const s = newSecret();
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(s, newSecret());
});

test("sha256Hex", () => {
  assert.equal(sha256Hex("a").length, 64);
});
