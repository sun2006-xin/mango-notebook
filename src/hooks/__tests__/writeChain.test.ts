import { describe, expect, it } from 'vitest';
import { createSerialWriteChain } from '../usePersist';

/* ============================================================================
   串行写链行为守护（usePersist R7「写序竞争」）

   缺口背景：写链原是 Hook 内裸 `useRef<Promise>.then` 挂链。QA 变异验证
   （把挂链改回并发写 `void (async () => {...})()`）时 348 条测试全绿、
   0 条变红 —— 没有任何行为守护。抽出的纯函数由本文件逐条守护语义契约：
   1) 按调用顺序串行执行（后入队必须等前一个 settle）；
   2) 前一个 work 抛错 → 后一个仍然执行（链不断）；
   3) 单个 enqueue 的 Promise 在自己的 work 完成后才 settle；
   4) 空链无悬挂（工厂同步返回、内部尾链即时决断）。
   ========================================================================= */

/** 冲刷微任务队列：让已 resolve 的尾链把排队中的 work 调度起来 */
async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe('createSerialWriteChain —— 串行语义', () => {
  it('两次 enqueue：按调用顺序执行，后一个等前一个 settle', async () => {
    const chain = createSerialWriteChain();
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = chain.enqueue(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = chain.enqueue(async () => {
      order.push('second:start');
    });

    // 第一条挂在门控上：第二条绝不能抢跑（并发写变异会在此处变红）
    await flushMicrotasks();
    expect(order).toEqual(['first:start']);

    releaseFirst();
    await first;
    // 第一条已结束：第二条此刻才被允许开始
    expect(order).toEqual(['first:start', 'first:end']);
    await second;
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('前一个 work 抛错 → 后一个仍然执行（链不断）', async () => {
    const chain = createSerialWriteChain();
    const order: string[] = [];

    const first = chain.enqueue(async () => {
      order.push('first');
      throw new Error('boom');
    });
    const second = chain.enqueue(async () => {
      order.push('second');
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBeUndefined();
    expect(order).toEqual(['first', 'second']);
  });

  it('单个 enqueue 的 Promise 在自己的 work 完成后才 resolve', async () => {
    const chain = createSerialWriteChain();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const done = chain.enqueue(async () => {
      await gate;
      order.push('work-done');
    });

    await flushMicrotasks();
    expect(order).toEqual([]); // work 没收尾 → Promise 不得提前 resolve

    release();
    await expect(done).resolves.toBeUndefined();
    expect(order).toEqual(['work-done']);
  });

  it('空链无悬挂：工厂同步返回，首条入队无需等待任何外部触发', async () => {
    const chain = createSerialWriteChain();
    await expect(chain.enqueue(async () => undefined)).resolves.toBeUndefined();
  });

  it('连续 5 条入队：严格按入队顺序执行（后写覆盖先写的基础）', async () => {
    const chain = createSerialWriteChain();
    const order: number[] = [];
    const works = [1, 2, 3, 4, 5].map((n) =>
      chain.enqueue(async () => {
        await Promise.resolve();
        order.push(n);
      }),
    );
    await Promise.all(works);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});
