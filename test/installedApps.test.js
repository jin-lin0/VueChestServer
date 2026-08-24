const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_INSTALLED_APPS,
  normalizeInstalledAppIds,
  selectExistingAppIds,
} = require("../utils/installedApps");

test("normalizes and deduplicates installed app ids", () => {
  assert.deepEqual(normalizeInstalledAppIds([3, 1, 3, 2]), [3, 1, 2]);
});

test("rejects malformed or oversized installed app lists", () => {
  assert.throws(() => normalizeInstalledAppIds("1,2"), /必须是数组/);
  assert.throws(() => normalizeInstalledAppIds([1, "2"]), /正整数/);
  assert.throws(() => normalizeInstalledAppIds([0]), /正整数/);
  assert.throws(
    () =>
      normalizeInstalledAppIds(
        Array.from({ length: MAX_INSTALLED_APPS + 1 }, (_, i) => i + 1),
      ),
    /最多包含/,
  );
});

test("keeps request order while filtering against approved database rows", () => {
  assert.deepEqual(
    selectExistingAppIds([8, 2, 5], [{ id: 5 }, { id: 8 }]),
    [8, 5],
  );
});
