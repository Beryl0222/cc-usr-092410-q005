import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../../src/event-store.js";
import { RetirementService } from "../../src/retirement-service.js";

/** 单调递增时钟：保证同进程内事件发生时间严格有序且确定。 */
export function makeClock(startIso = "2026-09-24T09:00:00+08:00") {
  let tick = 0;
  const base = Date.parse(startIso);
  return () => new Date(base + tick++ * 1000).toISOString();
}

export function newService({ file, now } = {}) {
  const store = new EventStore(file ? { file } : undefined);
  return new RetirementService(store, { now: now ?? makeClock() });
}

export function tempEventFile() {
  const dir = mkdtempSync(join(tmpdir(), "retirement-"));
  return join(dir, "events.jsonl");
}

/**
 * 标准展项世界：
 * - 学术来源 SRC-OK 在授权范围内；SRC-W 已撤回。
 * - timeline-map@2.3.0 引用了撤回来源；timeline-map@2.4.0 干净。
 * - quiz-wheel@1.2.0 同样引用撤回来源（用于两次相邻退役交错）。
 * - EX-A 仅用 timeline-map@2.3.0；EX-B 同时用 timeline-map@2.3.0 与 quiz-wheel@1.2.0；
 *   EX-C 仅用 quiz-wheel@1.2.0；EX-D 只用干净的 carousel@1.0.0。
 */
export function seedWorld(svc) {
  svc.registerThesis({ thesis_id: "TH-1", title: "数字敦煌互动展陈", owner_id: "curator-1" });
  svc.clearSource({ source_id: "SRC-OK", title: "已授权图集", rights_scope: "全场馆永久" });
  svc.withdrawSource({ source_id: "SRC-W", reason: "期刊撤稿，结论不再成立" });

  svc.releaseComponentVersion({ component_id: "timeline-map", component_version: "2.3.0", source_ids: ["SRC-W"], predecessor: null });
  svc.releaseComponentVersion({ component_id: "timeline-map", component_version: "2.4.0", source_ids: ["SRC-OK"], predecessor: "2.3.0" });
  svc.releaseComponentVersion({ component_id: "quiz-wheel", component_version: "1.2.0", source_ids: ["SRC-W"], predecessor: null });
  svc.releaseComponentVersion({ component_id: "carousel", component_version: "1.0.0", source_ids: ["SRC-OK"], predecessor: null });

  svc.registerReuse({ exhibit_id: "EX-A", exhibit_name: "丝路时序厅", channel_id: "CH-A", proposal_id: "PR-A", component_id: "timeline-map", component_version: "2.3.0", source_ids: ["SRC-W"], online_release: "REL-A-07" });
  svc.registerReuse({ exhibit_id: "EX-B", exhibit_name: "敦煌互动角", channel_id: "CH-B", proposal_id: "PR-B", component_id: "timeline-map", component_version: "2.3.0", source_ids: ["SRC-W"], online_release: "REL-B-11" });
  svc.registerReuse({ exhibit_id: "EX-B", exhibit_name: "敦煌互动角", channel_id: "CH-B", proposal_id: "PR-B", component_id: "quiz-wheel", component_version: "1.2.0", source_ids: ["SRC-W"], online_release: "REL-B-11" });
  svc.registerReuse({ exhibit_id: "EX-C", exhibit_name: "问答长廊", channel_id: "CH-C", proposal_id: "PR-C", component_id: "quiz-wheel", component_version: "1.2.0", source_ids: ["SRC-W"], online_release: "REL-C-03" });
  svc.registerReuse({ exhibit_id: "EX-D", exhibit_name: "图集回廊", channel_id: "CH-D", proposal_id: "PR-D", component_id: "carousel", component_version: "1.0.0", source_ids: ["SRC-OK"], online_release: "REL-D-02" });
}

/** 发起并冻结一个退役案，返回案视图。 */
export function openRetirement(svc, caseId, componentId, version, reason = "学术来源撤回", initiator = "platform-supervisor") {
  svc.initiateRetirement({ case_id: caseId, component_id: componentId, component_version: version, reason, reason_source_id: "SRC-W", initiator });
  return svc.freezeScope(caseId);
}

export const signers = { academic: { signer: "prof.wang", note: "学术依据已失效" }, legal: { signer: "legal.li", note: "授权与风险评估通过" } };

export function dualSign(svc, caseId) {
  svc.signOff(caseId, "academic", signers.academic);
  svc.signOff(caseId, "legal", signers.legal);
}

/** 向临时事件文件写入一行损坏/伪造事件，用于验证重启时拒绝被改写的历史。 */
export function appendRawLine(file, event) {
  writeFileSync(file, `${JSON.stringify(event)}\n`, { flag: "a" });
}
