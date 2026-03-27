import { describe, it, expect } from "vitest";
import { SerialQueue } from "../src/queue/serial-queue.js";

describe("SerialQueue", () => {
  it("starts not busy with zero length", () => {
    const q = new SerialQueue();
    expect(q.busy).toBe(false);
    expect(q.length).toBe(0);
  });

  it("executes a single task", async () => {
    const q = new SerialQueue();
    const result = await q.enqueue(async () => 42);
    expect(result).toBe(42);
    expect(q.busy).toBe(false);
  });

  it("executes tasks serially", async () => {
    const q = new SerialQueue();
    const order: number[] = [];

    const p1 = q.enqueue(async () => {
      await delay(50);
      order.push(1);
      return "a";
    });

    const p2 = q.enqueue(async () => {
      order.push(2);
      return "b";
    });

    // While first task runs, queue should have 1 pending
    expect(q.busy).toBe(true);
    expect(q.length).toBe(1);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("a");
    expect(r2).toBe("b");
    expect(order).toEqual([1, 2]);
  });

  it("rejects on task error without blocking the queue", async () => {
    const q = new SerialQueue();

    const p1 = q.enqueue(async () => {
      throw new Error("boom");
    });

    const p2 = q.enqueue(async () => "ok");

    await expect(p1).rejects.toThrow("boom");
    expect(await p2).toBe("ok");
    expect(q.busy).toBe(false);
  });

  it("reports queue length correctly", async () => {
    const q = new SerialQueue();

    const p1 = q.enqueue(() => delay(100).then(() => "a"));
    const p2 = q.enqueue(() => delay(10).then(() => "b"));
    const p3 = q.enqueue(() => delay(10).then(() => "c"));

    expect(q.length).toBe(2);

    await Promise.all([p1, p2, p3]);
    expect(q.length).toBe(0);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
