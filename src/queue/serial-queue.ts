/**
 * Serial task queue — ensures only one Claude process runs at a time.
 *
 * When a task is submitted while another is running, it is queued and
 * executed in FIFO order once the current task completes.
 *
 * Supports cancelling the current task via its child process handle.
 */

import type { ChildProcess } from "child_process";

interface QueueItem<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  childProcess?: ChildProcess;
}

export class SerialQueue {
  private currentTask: QueueItem<unknown> | null = null;
  private readonly pending: QueueItem<unknown>[] = [];

  /** Submit a task. Resolves when the task completes (possibly after waiting in queue). */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = { task, resolve, reject };
      if (!this.currentTask) {
        this.run(item);
      } else {
        this.pending.push(item as QueueItem<unknown>);
      }
    });
  }

  /** Attach a child process handle to the current task so it can be cancelled. */
  setChildProcess(cp: ChildProcess): void {
    if (this.currentTask) {
      this.currentTask.childProcess = cp;
    }
  }

  /** Send SIGTERM to the running child process. Returns true if a process was killed. */
  cancelCurrent(): boolean {
    if (this.currentTask?.childProcess) {
      this.currentTask.childProcess.kill("SIGTERM");
      return true;
    }
    return false;
  }

  get length(): number {
    return this.pending.length;
  }

  get busy(): boolean {
    return this.currentTask !== null;
  }

  private async run<T>(item: QueueItem<T>): Promise<void> {
    this.currentTask = item as QueueItem<unknown>;
    try {
      const result = await item.task();
      item.resolve(result);
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.currentTask = null;
      if (this.pending.length > 0) {
        this.run(this.pending.shift()!);
      }
    }
  }
}
