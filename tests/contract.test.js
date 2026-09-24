import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

async function loadSample(rel) {
  return JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));
}

test("立项样例符合领域约定", async () => {
  const sample = await loadSample("../data/sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("退役发起样例符合领域约定", async () => {
  const sample = await loadSample("../data/retirement-sample.json");
  assert.deepEqual(validateEvent(sample), []);
});
