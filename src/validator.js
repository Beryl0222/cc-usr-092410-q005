// 与 contracts/domain.schema.json 保持一致的运行时枚举；契约为对外交换依据，此处为进程内快速校验。
export const EVENT_TYPES = [
  "THESIS_SUBMITTED",
  "SOURCE_CLEARED",
  "SOURCE_WITHDRAWN",
  "COMPONENT_REUSE_REGISTERED",
  "SIMILARITY_FLAGGED",
  "CHANGE_REVIEWED",
  "VERSION_RELEASED",
  "COMPONENT_BLOCKED_URGENTLY",
  "RETIREMENT_INITIATED",
  "DEPLOYMENT_SCOPE_FROZEN",
  "REPLACEMENT_SUBMITTED",
  "SIGNED_OFF_BY_ACADEMIC",
  "SIGNED_OFF_BY_LEGAL",
  "DISPOSAL_DECIDED",
  "DISPOSAL_REQUESTED",
  "DISPOSAL_BATCH_CLOSED",
  "EXECUTION_RECEIPT_REPORTED",
  "EXECUTION_RECEIPT_CONFIRMED",
  "RECEIPT_DISCREPANCY_INVESTIGATION_OPENED",
  "INVESTIGATION_RESOLVED",
];

export const AGGREGATE_TYPES = [
  "curatorial_thesis",
  "research_asset",
  "experience_proposal",
  "approval_decision",
  "component_version",
  "retirement_case",
  "disposal_action",
  "execution_receipt",
  "receipt_investigation",
  "urgent_block",
];

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if ("occurred_at" in record && !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是 ISO-8601 日期时间");
  }
  for (const name of ["event_id", "aggregate_id", "summary"]) {
    if (name in record && (typeof record[name] !== "string" || record[name].length === 0)) {
      errors.push(`${name} 必须是非空字符串`);
    }
  }
  return errors;
}
