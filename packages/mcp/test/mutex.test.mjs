import test from "node:test";
import assert from "node:assert/strict";
import { createWriteMutex } from "../dist/mutex.js";

test("createWriteMutex: tasks run strictly one at a time", async () => {
  const mutex = createWriteMutex();
  const log = [];
  const task1 = mutex.run(async () => {
    log.push("start1");
    await new Promise(r => setTimeout(r, 10)); // < 50ms
    log.push("end1");
  });
  const task2 = mutex.run(async () => {
    log.push("start2");
    await new Promise(r => setTimeout(r, 10));
    log.push("end2");
  });

  await Promise.all([task1, task2]);
  assert.deepEqual(log, ["start1", "end1", "start2", "end2"]);
});

test("createWriteMutex: a rejected task releases the lock for the next one", async () => {
  const mutex = createWriteMutex();
  const log = [];
  const task1 = mutex.run(async () => {
    log.push("start1");
    throw new Error("fail");
  });
  const task2 = mutex.run(async () => {
    log.push("start2");
    return "ok";
  });

  await assert.rejects(task1, /fail/);
  const res2 = await task2;
  assert.equal(res2, "ok");
  assert.deepEqual(log, ["start1", "start2"]);
});

test("createWriteMutex: FIFO order is preserved for 5 queued tasks", async () => {
  const mutex = createWriteMutex();
  const log = [];
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push(mutex.run(async () => {
      log.push(i);
      await new Promise(r => setTimeout(r, 5));
    }));
  }
  await Promise.all(tasks);
  assert.deepEqual(log, [0, 1, 2, 3, 4]);
});

test("createWriteMutex: the return value of each task is passed through", async () => {
  const mutex = createWriteMutex();
  const res = await mutex.run(async () => 42);
  assert.equal(res, 42);
});

test("createWriteMutex: depth is updated correctly", async () => {
  const mutex = createWriteMutex();
  assert.equal(mutex.depth(), 0);

  let resolveTask = () => {};
  // The executor runs immediately if it's the first task, because `await Promise.resolve()`
  // lets the next microtask start, but we can also just provide a promise directly. Wait, `fn` must return a promise.
  const p1 = mutex.run(() => new Promise(r => {
    resolveTask = r;
  }));

  // It is synchronously added to queue, waiting increments synchronously.
  assert.equal(mutex.depth(), 1);

  const p2 = mutex.run(() => Promise.resolve());
  assert.equal(mutex.depth(), 2);

  // Need to let the event loop process the first task to set resolveTask
  await new Promise(r => setTimeout(r, 0));

  resolveTask();
  await p1;
  await p2;
  assert.equal(mutex.depth(), 0);
});

test("createWriteMutex returns independent locks", async () => {
  const mutex1 = createWriteMutex();
  const mutex2 = createWriteMutex();
  const log = [];

  const t1 = mutex1.run(async () => {
    log.push("m1-start");
    await new Promise(r => setTimeout(r, 10));
    log.push("m1-end");
  });

  const t2 = mutex2.run(async () => {
    log.push("m2-start");
    log.push("m2-end");
  });

  await Promise.all([t1, t2]);
  assert.deepEqual(log, ["m1-start", "m2-start", "m2-end", "m1-end"]);
});
