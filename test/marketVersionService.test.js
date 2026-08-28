const test = require("node:test");
const assert = require("node:assert/strict");

const {
  VERSION_RE,
  compareVersions,
  parseAllowNetwork,
  reviewFeedback,
} = require("../services/marketVersionService");

test("market version service compares releases and prereleases", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("v2.0", "2.0.0"), 0);
  assert.equal(compareVersions("2.0.0-beta.2", "2.0.0-beta.10"), -1);
  assert.equal(compareVersions("2.0.0", "2.0.0-beta.10"), 1);
  assert.equal(VERSION_RE.test("v2.1.0-beta.1+build.2"), true);
});

test("market version service normalizes network allowlists", () => {
  assert.deepEqual(parseAllowNetwork('[" api.example.com ","",3]'), ["api.example.com"]);
  assert.deepEqual(parseAllowNetwork("one.example.com, two.example.com"), [
    "one.example.com",
    "two.example.com",
  ]);
  assert.deepEqual(parseAllowNetwork({ invalid: true }), []);
});

test("market version service validates review feedback", () => {
  assert.deepEqual(reviewFeedback({}, false), { category: null, message: "" });
  assert.throws(
    () => reviewFeedback({ category: "security", message: "" }, true),
    (error) => error.status === 400,
  );
  assert.deepEqual(reviewFeedback({ category: "security", message: "存在风险" }, true), {
    category: "security",
    message: "存在风险",
  });
});
