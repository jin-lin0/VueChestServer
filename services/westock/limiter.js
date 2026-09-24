// 子进程并发闸门。westock CLI 每次调用都会在服务端 spawn 一个独立进程，
// 单实例同时跑太多会拖慢全部请求，因此统一在这里限流。
//
// 单独成模块是为了可测：并发逻辑的边界（名额泄漏、排队超时、队列满）很难通过
// HTTP 端到端覆盖，直接单测工厂函数最可靠。
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function createLimiter(options = {}) {
  const limit = positiveInt(options.max, 4);
  const queueLimit = positiveInt(options.maxQueue, 16);
  const waitMs = positiveInt(options.waitMs, 20000);
  const makeBusyError =
    options.makeBusyError ||
    (() =>
      Object.assign(new Error("westock 服务繁忙，请稍后重试"), {
        status: 503,
        code: "BUSY",
      }));

  let active = 0;
  const waiters = [];

  async function acquire() {
    if (active < limit) {
      active += 1;
      return;
    }
    if (waiters.length >= queueLimit) {
      throw makeBusyError();
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      // 排队同样受总时限约束，避免请求一直悬挂到函数超时。
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(makeBusyError());
      }, waitMs);
      waiters.push(waiter);
    });
  }

  function release() {
    const waiter = waiters.shift();
    if (waiter) {
      // 名额直接移交给排队者，active 保持不变。
      clearTimeout(waiter.timer);
      waiter.resolve();
      return;
    }
    // 防御重复 release，避免出现负计数把闸门永久放开。
    if (active > 0) active -= 1;
  }

  function stats() {
    return { active, queued: waiters.length, max: limit, maxQueue: queueLimit };
  }

  return { acquire, release, stats };
}

module.exports = { createLimiter, positiveInt };
