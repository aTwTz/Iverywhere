// NOTE: 排队等待从入队时刻起算；超时后任务被跳过，调用方收到明确错误，队列继续流转。
// NOTE(en): Queue wait is measured from enqueue time; on timeout the task is skipped, the caller gets an explicit error, and the queue keeps draining.
export function createAsyncQueue({ maxWaitMs } = {}) {
  let tail = Promise.resolve();

  return function enqueue(task) {
    const hasLimit = Number.isFinite(maxWaitMs) && maxWaitMs > 0;
    let timedOut = false;
    let timer;
    const waitGuard = hasLimit
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`queue wait exceeded limit of ${maxWaitMs}ms`));
          }, maxWaitMs);
        })
      : undefined;

    const run = () => {
      if (timer) clearTimeout(timer);
      if (timedOut) return undefined;
      return task();
    };
    const execution = tail.then(run, run);
    tail = execution.then(
      () => undefined,
      () => undefined,
    );

    if (!waitGuard) return execution;
    // NOTE: 超时胜出后 execution 仍会迟到落定；吞掉迟到结果，避免未处理拒绝。
    // NOTE(en): execution still settles after the guard wins the race; swallow the late outcome so it never becomes an unhandled rejection.
    execution.catch(() => undefined);
    return Promise.race([execution, waitGuard]);
  };
}
