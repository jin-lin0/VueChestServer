const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSha256,
  storedObjectSha256,
  assertObjectIntegrity,
} = require("../utils/bundleIntegrity");

const digest = "a".repeat(64);

test("normalizes valid SHA-256 values", () => {
  assert.equal(normalizeSha256(digest.toUpperCase(), true), digest);
  assert.equal(normalizeSha256("", false), null);
  assert.throws(() => normalizeSha256("invalid", true), /SHA-256/);
});

test("verifies R2 object metadata", () => {
  const object = { Metadata: { sha256: digest } };
  assert.equal(storedObjectSha256(object), digest);
  assert.equal(assertObjectIntegrity(object, digest), digest);
  assert.throws(() => assertObjectIntegrity(object, "b".repeat(64)), /不匹配/);
});
