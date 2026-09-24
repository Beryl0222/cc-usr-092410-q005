import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * Append-only 事件存储（JSONL）。
 *
 * 不变量：
 * - 事件只追加，不提供任何改写或删除接口；
 * - event_id 全局唯一；
 * - 同一聚合的 version 严格 +1；
 * - seq 为全局单调序号，服务重启重放后保持不变。
 */
export class EventStore {
  /** @param {string} filePath JSONL 文件路径；":memory:" 表示不落盘。 */
  constructor(filePath = ":memory:") {
    this.filePath = filePath;
    /** @type {Array<Record<string, unknown>>} */
    this.events = [];
    this.seenIds = new Set();
    this.aggregateVersions = new Map();
    /** @type {Set<(event: Record<string, unknown>) => void>} */
    this.listeners = new Set();
    if (filePath !== ":memory:" && existsSync(filePath)) {
      const text = readFileSync(filePath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this._ingest(JSON.parse(line));
      }
    }
  }

  _ingest(event) {
    if (this.seenIds.has(event.event_id)) {
      throw new Error(`事件编号重复：${event.event_id}`);
    }
    const last = this.aggregateVersions.get(event.aggregate_id) ?? 0;
    if (event.version !== last + 1) {
      throw new Error(
        `聚合 ${event.aggregate_id} 版本断裂：期望 ${last + 1}，收到 ${event.version}`,
      );
    }
    this.seenIds.add(event.event_id);
    this.aggregateVersions.set(event.aggregate_id, event.version);
    event.seq = this.events.length + 1;
    this.events.push(event);
  }

  /** 追加一个事件（信封字段由调用方填好），返回带 seq 的入库事件。 */
  append(event) {
    this._ingest(event);
    if (this.filePath !== ":memory:") {
      appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    }
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** 订阅新追加的事件（重放历史不触发），返回退订函数。 */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  all() {
    return this.events.slice();
  }

  byAggregate(aggregateId) {
    return this.events.filter((e) => e.aggregate_id === aggregateId);
  }

  nextVersion(aggregateId) {
    return (this.aggregateVersions.get(aggregateId) ?? 0) + 1;
  }
}
