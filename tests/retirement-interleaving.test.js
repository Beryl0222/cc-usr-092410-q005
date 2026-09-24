import assert from "node:assert/strict";
import test from "node:test";

import { newService, seedWorld, openRetirement, dualSign } from "./helpers/fixture.js";

/**
 * 两次相邻退役交错发生，证明：
 * 1. 后一批退役冻结时，凡受前一批“未确认动作”影响的展项被排除，顺序不被打乱；
 * 2. 冻结快照一经形成不可变——前批动作后来完成，也不会倒灌进后批的冻结范围；
 * 3. 前批动作完成后，新的退役可以把该展项重新纳入。
 */
test("相邻退役交错：RC-1 未完成时 RC-2 冻结排除重叠展项，完成后新批次可纳入", () => {
  const svc = newService();
  seedWorld(svc);

  // —— 第一批：timeline-map@2.3.0，命中 EX-A、EX-B ——
  openRetirement(svc, "RC-1", "timeline-map", "2.3.0");
  svc.submitReplacement({ case_id: "RC-1", exhibit_id: "EX-B", owner_id: "owner-b", replacement_ref: "timeline-map@2.4.0" });
  dualSign(svc, "RC-1");
  svc.decideDisposals("RC-1", [
    { exhibit_id: "EX-A", kind: "pause", note: "暂停" },
    { exhibit_id: "EX-B", kind: "replace", note: "升级" },
  ]);
  svc.dispatchBatch("RC-1"); // EX-A、EX-B 均下发，此刻都未确认

  // EX-A 很快确认；EX-B 因素材排期仍未回执。
  svc.reportReceipt({ receipt_no: "RCP-A1", action_id: "DA-RC-1-EX-A", channel_id: "CH-A", content: { paused: true } });
  svc.confirmReceipt({ receipt_no: "RCP-A1", confirmed_by: "ops-1" });
  assert.equal(svc.getAction("DA-RC-1-EX-B").status, "requested");

  // —— 第二批（相邻退役）：quiz-wheel@1.2.0，命中 EX-B、EX-C ——
  const frozen2 = openRetirement(svc, "RC-2", "quiz-wheel", "1.2.0");
  const inScope = frozen2.frozen_scope.deployments.map((d) => d.exhibit_id);
  const excluded = frozen2.frozen_scope.excluded;

  // EX-B 受 RC-1 未确认动作 DA-RC-1-EX-B 影响，被排除；EX-C 正常纳入。
  assert.ok(!inScope.includes("EX-B"), "EX-B 不得进入 RC-2 冻结范围");
  assert.ok(inScope.includes("EX-C"));
  assert.deepEqual(
    excluded.map((e) => ({ exhibit_id: e.exhibit_id, blocking_action_ids: e.blocking_action_ids })),
    [{ exhibit_id: "EX-B", blocking_action_ids: ["DA-RC-1-EX-B"] }],
  );

  // RC-2 不得对被排除的 EX-B 形成决定（它根本不在命中冻结范围内）。
  dualSign(svc, "RC-2");
  assert.throws(
    () => svc.decideDisposals("RC-2", [{ exhibit_id: "EX-B", kind: "pause", note: "越权" }]),
    /不在冻结的命中范围/,
  );

  // RC-2 只处理 EX-C，先于 RC-1 的 EX-B 完成——交错完成顺序与发起顺序相反。
  svc.decideDisposals("RC-2", [{ exhibit_id: "EX-C", kind: "pause", note: "暂停问答" }]);
  svc.dispatchBatch("RC-2");
  svc.reportReceipt({ receipt_no: "RCP-C1", action_id: "DA-RC-2-EX-C", channel_id: "CH-C", content: { paused: true } });
  svc.confirmReceipt({ receipt_no: "RCP-C1", confirmed_by: "ops-2" });
  assert.equal(svc.getAction("DA-RC-2-EX-C").status, "receipt_confirmed");
  assert.equal(svc.getAction("DA-RC-1-EX-B").status, "requested", "RC-1 的 EX-B 进度不被 RC-2 推进或打乱");

  // RC-1 的 EX-B 此时才完成。
  svc.reportReceipt({ receipt_no: "RCP-B1", action_id: "DA-RC-1-EX-B", channel_id: "CH-B", content: { replaced_to: "timeline-map@2.4.0" } });
  svc.confirmReceipt({ receipt_no: "RCP-B1", confirmed_by: "ops-1" });

  // 关键不变量：RC-2 的冻结快照永远记录 EX-B 被排除，不因其后完成而倒灌改变。
  const frozen2Again = svc.describeCase("RC-2").frozen_scope;
  assert.ok(!frozen2Again.deployments.some((d) => d.exhibit_id === "EX-B"));
  assert.deepEqual(frozen2Again.excluded.map((e) => e.exhibit_id), ["EX-B"]);

  // 新的退役在所有前序动作确认后发起：EX-B 重新可被纳入。
  const frozen3 = openRetirement(svc, "RC-3", "quiz-wheel", "1.2.0", "授权年度复核");
  assert.ok(frozen3.frozen_scope.deployments.some((d) => d.exhibit_id === "EX-B" && d.affected), "EX-B 在无未确认动作后应纳入 RC-3");
  assert.deepEqual(frozen3.frozen_scope.excluded, []);
});

test("交错期间事件按聚合严格有序，因果与关联编号不错位", () => {
  const svc = newService();
  seedWorld(svc);
  openRetirement(svc, "RC-1", "timeline-map", "2.3.0");
  dualSign(svc, "RC-1");
  svc.decideDisposals("RC-1", [{ exhibit_id: "EX-A", kind: "pause", note: "暂停" }]);
  svc.dispatchBatch("RC-1");
  openRetirement(svc, "RC-2", "quiz-wheel", "1.2.0");

  // RC-1 聚合版本连续 1..N，RC-2 独立从 1 计数。
  const versionsOf = (caseId) =>
    svc.store.events({ aggregate_type: "retirement_case", aggregate_id: caseId }).map((e) => e.version);
  const v1 = versionsOf("RC-1");
  const v2 = versionsOf("RC-2");
  assert.deepEqual(v1, v1.map((_, i) => i + 1));
  assert.deepEqual(v2, [1, 2]);

  // 处置动作的下发事件带批次因果号与退役案关联号。
  const requested = svc.store.events({ aggregate_type: "disposal_action", aggregate_id: "DA-RC-1-EX-A" });
  const req = requested.find((e) => e.event_type === "DISPOSAL_REQUESTED");
  assert.equal(req.causation_id, "B-RC-1-1");
  assert.equal(req.correlation_id, "RC-1");

  // 全局事件流时间戳单调不减（交错写入保持提交顺序）。
  const times = svc.store.all().map((e) => Date.parse(e.occurred_at));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], "事件流顺序被打乱");
});
