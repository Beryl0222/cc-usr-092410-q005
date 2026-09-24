import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { validateEvent } from "./validator.js";

/**
 * 仅追加事件存储。
 *
 * 不变量：
 * - 事件只增不改不删；旧发布记录与已确认回执因此天然不可改写。
 * - event_id 全局唯一。
 * - 同一聚合 (aggregate_type, aggregate_id) 的 version 从 1 起严格连续递增，
 *   乱序或重号一律拒绝，服务重启后靠重放恢复同一判断。
 * - 给定 file 路径时以 JSONL 逐行落盘，重启重放即可从各展项进度继续。
 */
export class EventStore {
  #events = [];
  #seenIds = new Set();
  #nextVersion = new Map();
  #file;

  constructor({ file } = {}) {
    this.#file = file;
    if (file && existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
      for (const line of lines) {
        const event = JSON.parse(line);
        this.#ingest(event);
      }
    }
  }

  #ingest(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`事件信封不合法：${errors.join("；")}`);
    if (this.#seenIds.has(event.event_id)) {
      throw new Error(`事件编号重复，拒绝写入：${event.event_id}`);
    }
    const key = aggregateKey(event.aggregate_type, event.aggregate_id);
    const expected = (this.#nextVersion.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      throw new Error(
        `聚合 ${key} 版本乱序：期望 ${expected}，实际 ${event.version}（事件 ${event.event_id}）`,
      );
    }
    this.#seenIds.add(event.event_id);
    this.#nextVersion.set(key, expected);
    this.#events.push(event);
  }

  /** 追加一条事件；version 由存储按聚合自动分配，调用方不得自行指定。 */
  append({ event_type, aggregate_type, aggregate_id, summary, payload, causation_id, correlation_id }, now) {
    const key = aggregateKey(aggregate_type, aggregate_id);
    const version = (this.#nextVersion.get(key) ?? 0) + 1;
    const event = {
      event_id: `${aggregate_type}_${aggregate_id}_${version}`,
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at: now(),
      version,
      summary,
    };
    if (payload !== undefined) event.payload = payload;
    if (causation_id !== undefined) event.causation_id = causation_id;
    if (correlation_id !== undefined) event.correlation_id = correlation_id;

    this.#ingest(event);
    if (this.#file) appendFileSync(this.#file, `${JSON.stringify(event)}\n`);
    return event;
  }

  events({ aggregate_type, aggregate_id } = {}) {
    return this.#events.filter(
      (event) =>
        (aggregate_type === undefined || event.aggregate_type === aggregate_type) &&
        (aggregate_id === undefined || event.aggregate_id === aggregate_id),
    );
  }

  all() {
    return [...this.#events];
  }

  get size() {
    return this.#events.length;
  }
}

export function aggregateKey(aggregate_type, aggregate_id) {
  return `${aggregate_type}:${aggregate_id}`;
}
