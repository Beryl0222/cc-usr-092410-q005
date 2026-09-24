import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/event-store.js";
import { RetirementService } from "../src/retirement-service.js";
import { newService, seedWorld, openRetirement, dualSign, tempEventFile, appendRawLine, makeClock } from "./helpers/fixture.js";

test("服务重启：从 JSONL 重放，各展项处置进度、调查项、批次快照原样续跑", () => {
  const file = tempEventFile();
  const svc1 = newService({ file, now: makeClock() });
  seedWorld(svc1);
  openRetirement(svc1, "RC-1", "timeline-map", "2.3.0");
  svc1.submitReplacement({ case_id: "RC-1", exhibit_id: "EX-B", owner_id: "b", replacement_ref: "timeline-map@2.4.0" });
  dualSign(svc1, "RC-1");
  svc1.decideDisposals("RC-1", [
    { exhibit_id: "EX-A", kind: "pause", note: "暂停" },
    { exhibit_id: "EX-B", kind: "replace", note: "升级" },
  ]);
  svc1.dispatchBatch("RC-1");
  // EX-A 已上报待核但尚未确认；EX-B 处于调查中——两者都是“未完成进度”，重启后必须保留。
  svc1.reportReceipt({ receipt_no: "RCP-A", action_id: "DA-RC-1-EX-A", channel_id: "CH-A", content: { paused: true } });
  svc1.reportReceipt({ receipt_no: "RCP-B", action_id: "DA-RC-1-EX-B", channel_id: "CH-B", content: { replaced: true } });
  const inv = svc1.reportReceipt({ receipt_no: "RCP-B", action_id: "DA-RC-1-EX-B", channel_id: "CH-B", content: { replaced: false } });
  const eventCountBefore = svc1.store.size;

  // —— 模拟服务重启：新进程、新服务实例，仅靠同一事件文件重建 ——
  const svc2 = RetirementService.reboot(new EventStore({ file }), { now: makeClock("2026-09-25T09:00:00+08:00") });
  assert.equal(svc2.store.size, eventCountBefore, "重启不增删事件");
  assert.equal(svc2.getAction("DA-RC-1-EX-A").status, "receipt_reported", "待核进度续跑");
  assert.equal(svc2.getAction("DA-RC-1-EX-B").status, "under_investigation", "调查中进度续跑");
  assert.equal(svc2.getAction("DA-RC-1-EX-B").investigation.status, "open");

  // 重启后继续完成剩余动作。
  svc2.confirmReceipt({ receipt_no: "RCP-A", confirmed_by: "ops" });
  assert.equal(svc2.getAction("DA-RC-1-EX-A").status, "receipt_confirmed");
  svc2.resolveInvestigation({ investigation_id: inv.investigation_id, confirmed: true, resolution_note: "确认", resolver: "auditor" });
  assert.equal(svc2.getAction("DA-RC-1-EX-B").status, "investigated_confirmed");

  // 重启前后读到的案视图决定、签署一致。
  const c2 = svc2.describeCase("RC-1");
  assert.equal(c2.signoffs.academic.length, 1);
  assert.equal(c2.signoffs.legal.length, 1);
  assert.deepEqual(c2.decisions.map((d) => d.kind).sort(), ["pause", "replace"]);
});

test("事件存储不可变：重复事件号与版本乱序一律拒绝；历史不能被原地改写", () => {
  // 正常写入：同一聚合版本由存储自动连续分配。
  const store = new EventStore();
  store.append({ event_type: "THESIS_SUBMITTED", aggregate_type: "curatorial_thesis", aggregate_id: "T1", summary: "s" }, () => "2026-09-24T01:00:00Z");
  store.append({ event_type: "SOURCE_WITHDRAWN", aggregate_type: "research_asset", aggregate_id: "S1", summary: "s" }, () => "2026-09-24T01:00:01Z");
  assert.deepEqual(
    store.events({ aggregate_type: "research_asset", aggregate_id: "S1" }).map((e) => e.version),
    [1],
  );

  // 篡改一：在同一聚合上伪造跳号版本，重放时必须拒绝（乱序）。
  const gapFile = tempEventFile();
  new EventStore({ file: gapFile }).append(
    { event_type: "THESIS_SUBMITTED", aggregate_type: "curatorial_thesis", aggregate_id: "T8", summary: "s" },
    () => "2026-09-24T01:00:00Z",
  );
  appendRawLine(gapFile, {
    event_id: "curatorial_thesis_T8_9",
    event_type: "CHANGE_REVIEWED",
    aggregate_type: "curatorial_thesis",
    aggregate_id: "T8",
    occurred_at: "2026-09-24T01:00:05Z",
    version: 9,
    summary: "伪造跳号",
  });
  assert.throws(() => new EventStore({ file: gapFile }), /版本乱序/);

  // 篡改二：伪造一个与既有 event_id 相同的事件行，重放时必须拒绝（重复）。
  const dupFile = tempEventFile();
  const good = new EventStore({ file: dupFile });
  good.append({ event_type: "THESIS_SUBMITTED", aggregate_type: "curatorial_thesis", aggregate_id: "T9", summary: "s" }, () => "2026-09-24T01:00:00Z");
  const firstId = good.all()[0].event_id;
  appendRawLine(dupFile, {
    event_id: firstId,
    event_type: "SOURCE_WITHDRAWN",
    aggregate_type: "research_asset",
    aggregate_id: "S9",
    occurred_at: "2026-09-24T01:00:03Z",
    version: 1,
    summary: "伪装成旧事件的篡改",
  });
  assert.throws(() => new EventStore({ file: dupFile }), /事件编号重复/);
});

test("紧急阻断：立即命中含该组件的展项，但不产生或改写任何处置回执与旧发布", () => {
  const svc = newService();
  seedWorld(svc);
  const releasesBefore = svc.store.events({ aggregate_type: "component_version" }).length;

  svc.urgentBlock({ block_id: "UB-1", component_id: "timeline-map", component_version: "2.3.0", reason: "发现严重史实错误，先阻断", operator: "duty-admin" });
  const hit = svc.currentlyBlockedExhibits().map((h) => h.exhibit_id).sort();
  assert.deepEqual(hit, ["EX-A", "EX-B"]);
  assert.ok(!svc.currentlyBlockedExhibits().some((h) => h.exhibit_id === "EX-C"), "EX-C 用的是 quiz-wheel，不命中");

  // 同一版本不可重复阻断。
  assert.throws(() => svc.urgentBlock({ block_id: "UB-2", component_id: "timeline-map", component_version: "2.3.0", reason: "再次", operator: "x" }), /已存在紧急阻断/);

  // 阻断之后发起的退役自动关联该阻断；旧发布记录数量不变。
  const c = openRetirement(svc, "RC-1", "timeline-map", "2.3.0");
  assert.deepEqual(c.related_blocks, ["UB-1"]);
  assert.equal(svc.store.events({ aggregate_type: "component_version" }).length, releasesBefore, "旧发布记录未被改写");
});

test("谱系追溯：从任一上线版本追到组件谱系、证据变化、签署决定与实际执行", () => {
  const svc = newService();
  seedWorld(svc);
  openRetirement(svc, "RC-1", "timeline-map", "2.3.0");
  svc.submitReplacement({ case_id: "RC-1", exhibit_id: "EX-B", owner_id: "b", replacement_ref: "timeline-map@2.4.0" });
  dualSign(svc, "RC-1");
  svc.decideDisposals("RC-1", [
    { exhibit_id: "EX-A", kind: "pause", note: "暂停" },
    { exhibit_id: "EX-B", kind: "replace", note: "升级" },
  ]);
  svc.dispatchBatch("RC-1");
  svc.reportReceipt({ receipt_no: "RCP-A", action_id: "DA-RC-1-EX-A", channel_id: "CH-A", content: { paused: true } });
  svc.confirmReceipt({ receipt_no: "RCP-A", confirmed_by: "ops" });

  // 从 EX-A 的某个上线版本号切入（管理者只知道上线版本）。
  const trace = svc.trace({ exhibit_id: "EX-A", online_release: "REL-A-07" });
  assert.equal(trace.component.component_id, "timeline-map");
  assert.equal(trace.component.component_version, "2.3.0");

  // 组件谱系：发布记录（含前驱、来源）+ 跨展项复用 + 冻结快照。
  assert.equal(trace.genealogy.releases[0].predecessor, null);
  assert.deepEqual(trace.genealogy.releases[0].source_ids, ["SRC-W"]);
  const reusedBy = trace.genealogy.reuse_across_exhibits.map((r) => r.exhibit_id).sort();
  assert.deepEqual(reusedBy, ["EX-A", "EX-B"], "同一组件被多个展项复用都可追到");
  assert.ok(trace.genealogy.frozen_snapshots.some((s) => s.case_id === "RC-1" && s.exhibit_id === "EX-A"));

  // 证据变化：撤回来源被记录为后继事件。
  assert.deepEqual(trace.evidence_changes.map((e) => e.source_id), ["SRC-W"]);

  // 签署决定与实际执行可追到动作级。
  const rc1 = trace.retirement_cases.find((c) => c.case_id === "RC-1");
  assert.equal(rc1.signoffs.academic.length, 1);
  assert.equal(rc1.signoffs.legal.length, 1);
  const exA = rc1.decisions.find((d) => d.exhibit_id === "EX-A");
  assert.equal(exA.kind, "pause");
  assert.equal(exA.execution.status, "receipt_confirmed");
  assert.equal(exA.execution.receipt.receipt_no, "RCP-A");
});
