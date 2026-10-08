/**
 * 进程内串行化。
 *
 * 单库后台串行是产品约束：同一时刻只允许一个写事务，避免两段异步逻辑在
 * “读-改-写”之间交错。跨进程互斥由存储后端的比较-写入加锁文件负责，
 * 这一层只保证**同一运行时**内的顺序。
 */

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  /** 当前排队/执行中的事务数。 */
  get pending(): number {
    return this.depth;
  }

  /** 串行执行；无论成功失败都不会卡住后续任务。 */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.depth += 1;
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => {
        this.depth -= 1;
      },
      () => {
        this.depth -= 1;
      },
    );
    return result;
  }

  /** 等待队列清空（测试与卸载时使用）。 */
  async drain(): Promise<void> {
    await this.tail;
  }
}

/** 极简读写计数，用于可观察性。 */
export interface RuntimeStats {
  reads: number;
  writes: number;
  conflicts: number;
  modelCalls: number;
  modelFailures: number;
}

export function emptyRuntimeStats(): RuntimeStats {
  return { reads: 0, writes: 0, conflicts: 0, modelCalls: 0, modelFailures: 0 };
}
