const { randomUUID } = require("node:crypto");
const { Op } = require("sequelize");
const { TaskError } = require("../../utils/taskCredentials");

// 租约要在单任务超时之后再留一小段余量：任务刚超时释放的瞬间，
// 另一个实例不该立刻抢到同一行，避免一次执行被两边同时跑。
const LEASE_GRACE_MS = 5000;

function leaseDuration(runMs) {
  return Math.max(1, runMs) + LEASE_GRACE_MS;
}

/**
 * 乐观抢占：只有「没租约 / 租约过期（且未 force 时今日未完成）」才能写入自己的 token。
 * 并发实例靠这条条件 UPDATE 自然互斥，不需要额外锁表。
 */
async function claimLease(State, { id, day, leaseMs, now, force = false }) {
  const leaseToken = randomUUID();
  const claimable = [
    {
      [Op.or]: [
        { leaseUntil: null },
        { leaseUntil: { [Op.lte]: new Date(now) } },
      ],
    },
  ];
  // 超管手动执行可忽略「当日已完成」，但租约仍然生效。
  if (!force)
    claimable.push({
      [Op.or]: [
        { lastCompletedDate: null },
        { lastCompletedDate: { [Op.ne]: day } },
      ],
    });
  const [claimed] = await State.update(
    { leaseToken, leaseUntil: new Date(now + leaseMs) },
    { where: { id, [Op.and]: claimable } },
  );
  return claimed ? leaseToken : null;
}

/** 释放租约；成功时顺带标记当日已完成。返回 false 表示租约已不属于自己。 */
async function releaseLease(State, { id, leaseToken }, { day, completed }) {
  const [released] = await State.update(
    {
      leaseToken: null,
      leaseUntil: null,
      ...(completed ? { lastCompletedDate: day } : {}),
    },
    { where: { id, leaseToken } },
  );
  return released > 0;
}

/**
 * 执行期间校验租约仍归自己所有；凭据轮换这类写回必须过这一关，
 * 否则过期实例会把新执行者的凭据覆盖掉。
 */
async function assertLeaseHeld(State, { id, leaseToken }, timestamp, message) {
  const latest = await State.findByPk(id);
  if (
    !latest ||
    latest.leaseToken !== leaseToken ||
    new Date(latest.leaseUntil).getTime() <= timestamp
  )
    throw new TaskError(message, "DAILY_LEASE_LOST");
  return latest;
}

module.exports = {
  LEASE_GRACE_MS,
  leaseDuration,
  claimLease,
  releaseLease,
  assertLeaseHeld,
};
