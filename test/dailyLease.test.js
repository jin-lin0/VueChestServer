const test = require("node:test");
const assert = require("node:assert/strict");
const { Op } = require("sequelize");
const {
  leaseDuration,
  claimLease,
  releaseLease,
  assertLeaseHeld,
  LEASE_GRACE_MS,
} = require("../services/daily/lease");

function fakeState(seed = {}) {
  const rows = new Map();
  return {
    rows,
    async update(values, { where }) {
      const row = rows.get(where.id);
      if (!row) return [0];
      if (where[Op.and]) {
        const ok = where[Op.and].every((cond) => {
          const or = cond[Op.or];
          if (or)
            return or.some((item) => {
              const key = Object.keys(item)[0];
              const expected = item[key];
              const actual = row[key];
              if (expected === null) return actual === null;
              if (expected[Op.ne] !== undefined)
                return actual !== expected[Op.ne];
              if (expected[Op.lte] !== undefined)
                return actual != null && new Date(actual) <= expected[Op.lte];
              return actual === expected;
            });
          const key = Object.keys(cond)[0];
          return row[key] === cond[key];
        });
        if (!ok) return [0];
      }
      for (const key of Object.keys(where)) {
        if (key === "id" || key === Op.and) continue;
        if (row[key] !== where[key]) return [0];
      }
      Object.assign(row, values);
      return [1];
    },
    async findByPk(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    seed(id, value) {
      rows.set(id, { id, ...seed, ...value });
    },
  };
}

test("租约时长在单任务超时之外留出固定余量", () => {
  assert.equal(leaseDuration(15000), 15000 + LEASE_GRACE_MS);
  assert.equal(leaseDuration(0), 1 + LEASE_GRACE_MS);
  // 关键不变量：租约必须比执行超时更长，否则任务未结束就会被并发实例抢走
  assert.ok(leaseDuration(120000) > 120000);
});

test("抢占写入的租约覆盖整段执行时间，并拒绝未到期的重复抢占", async () => {
  const State = fakeState();
  const now = 1_000_000;
  State.seed("1:a", { lastCompletedDate: null, leaseUntil: null, leaseToken: null });

  const token = await claimLease(State, {
    id: "1:a",
    day: "2026-11-09",
    leaseMs: leaseDuration(30000),
    now,
  });
  assert.ok(token);
  const row = State.rows.get("1:a");
  assert.equal(row.leaseToken, token);
  assert.equal(new Date(row.leaseUntil).getTime(), now + 35000);

  const second = await claimLease(State, {
    id: "1:a",
    day: "2026-11-09",
    leaseMs: 1000,
    now,
  });
  assert.equal(second, null, "租约未到期时不能重复抢占");
});

test("过期租约可被抢占，释放后凭据回写会失效", async () => {
  const State = fakeState();
  State.seed("1:a", {
    lastCompletedDate: null,
    leaseUntil: new Date(1_000_000 - 1),
    leaseToken: "stale",
  });

  const token = await claimLease(State, {
    id: "1:a",
    day: "2026-11-09",
    leaseMs: 5000,
    now: 1_000_000,
  });
  assert.ok(token && token !== "stale");

  await assert.rejects(
    () => assertLeaseHeld(State, { id: "1:a", leaseToken: "stale" }, 1_000_000, "锁已失效"),
    /锁已失效/,
  );

  assert.equal(await releaseLease(State, { id: "1:a", leaseToken: token }, {
    day: "2026-11-09",
    completed: true,
  }), true);
  const row = State.rows.get("1:a");
  assert.equal(row.leaseToken, null);
  assert.equal(row.lastCompletedDate, "2026-11-09");

  // 旧 token 再释放会失败，不会把别人的执行状态清掉
  assert.equal(await releaseLease(State, { id: "1:a", leaseToken: token }, {
    day: "2026-11-09",
    completed: false,
  }), false);
});
