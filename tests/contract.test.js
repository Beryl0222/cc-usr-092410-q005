import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("样例事件流的每条记录都符合信封约定", async () => {
  const text = await readFile(new URL("../data/sample-stream.jsonl", import.meta.url), "utf8");
  const events = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.length > 10, "样例流应包含完整退役生命周期");
  const seqSeen = new Set();
  for (const event of events) {
    assert.deepEqual(validateEvent(event), []);
    assert.ok(!seqSeen.has(event.event_id), `event_id 重复：${event.event_id}`);
    seqSeen.add(event.event_id);
  }
});
