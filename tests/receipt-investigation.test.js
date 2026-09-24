import assert from "node:assert/strict";
import test from "node:test";

import { newService, seedWorld, openRetirement, dualSign } from "./helpers/fixture.js";

function decidedPauseCase(svc, caseId = "RC-1", exhibit = "EX-A", channel = "CH-A") {
  openRetirement(svc, caseId, "timeline-map", "2.3.0");
  dualSign(svc, caseId);
  svc.decideDisposals(caseId, [{ exhibit_id: exhibit, kind: "pause", note: "暂停" }]);
  svc.dispatchBatch(caseId);
  return { action: `DA-${caseId}-${exhibit}`, channel };
}

test("同回执编号不同内容：原报告保留、不计成功，并开立调查项而非覆盖", () => {
  const svc = newService();
  seedWorld(svc);
  const { action, channel } = decidedPauseCase(svc);

  const first = svc.reportReceipt({ receipt_no: "RCP-X", action_id: action, channel_id: channel, content: { paused: true } });
  assert.equal(first.outcome, "reported");
  assert.equal(svc.getAction(action).status, "receipt_reported", "首报仅待核，尚未成功");

  // 同内容重复送达：忽略，不报错也不重复处理。
  const dup = svc.reportReceipt({ receipt_no: "RCP-X", action_id: action, channel_id: channel, content: { paused: true } });
  assert.equal(dup.outcome, "ignored_duplicate");

  // 不同执行内容使用同一回执编号：触发调查。
  const conflict = svc.reportReceipt({ receipt_no: "RCP-X", action_id: action, channel_id: channel, content: { paused: false, still_running: true } });
  assert.equal(conflict.outcome, "investigation_opened");
  assert.ok(conflict.investigation_id);
  assert.equal(svc.getAction(action).status, "under_investigation", "存在异议时动作不得计为成功");

  // 调查期间禁止核验确认。
  assert.throws(() => svc.confirmReceipt({ receipt_no: "RCP-X", confirmed_by: "ops" }), /未结调查/);

  // 两次相互冲突的不同执行内容都原样保留，第一份没有被第二份覆盖
  // （中间那次同内容重复送达也作为事件留痕，但不产生新的不同内容）。
  const receipt = svc.getAction(action).receipt;
  assert.equal(receipt.reports.length, 3);
  const distinct = receipt.reports.filter((r, i, arr) => arr.findIndex((x) => x.content_hash === r.content_hash) === i);
  assert.equal(distinct.length, 2);
  assert.deepEqual(distinct[0].content, { paused: true });
  assert.deepEqual(distinct[1].content, { paused: false, still_running: true });
  assert.notEqual(distinct[0].content_hash, distinct[1].content_hash);
});

test("调查确认执行属实：动作以 investigated_confirmed 定案", () => {
  const svc = newService();
  seedWorld(svc);
  const { action, channel } = decidedPauseCase(svc);
  svc.reportReceipt({ receipt_no: "RCP-X", action_id: action, channel_id: channel, content: { paused: true } });
  const inv = svc.reportReceipt({ receipt_no: "RCP-X", action_id: action, channel_id: channel, content: { paused: true, evidence: "photo" } });
  assert.equal(inv.outcome, "investigation_opened");

  svc.resolveInvestigation({ investigation_id: inv.investigation_id, confirmed: true, resolution_note: "两份内容均证明已暂停", resolver: "auditor-1" });
  assert.equal(svc.getAction(action).status, "investigated_confirmed");

  // 调查结论不可改写。
  assert.throws(
    () => svc.resolveInvestigation({ investigation_id: inv.investigation_id, confirmed: false, resolution_note: "改判", resolver: "x" }),
    /已有结论/,
  );
});

test("调查认定执行不成立：动作退回待重报，须用新回执编号重新上报后确认", () => {
  const svc = newService();
  seedWorld(svc);
  const { action, channel } = decidedPauseCase(svc);
  svc.reportReceipt({ receipt_no: "RCP-X", action_id: action, channel_id: channel, content: { paused: true } });
  const inv = svc.reportReceipt({ receipt_no: "RCP-X", action_id: action, channel_id: channel, content: { paused: false } });

  svc.resolveInvestigation({ investigation_id: inv.investigation_id, confirmed: false, resolution_note: "现场仍在运行", resolver: "auditor-1" });
  assert.equal(svc.getAction(action).status, "requested", "不成立则退回待重报，进度保留但不计成功");
  assert.equal(svc.getAction(action).investigation_id, inv.investigation_id, "调查编号作为历史关联保留");

  // 旧编号不能再用来确认（其执行已被否定）；须以新回执重报。
  assert.throws(() => svc.confirmReceipt({ receipt_no: "RCP-X", confirmed_by: "ops" }), /被调查否定|未结调查/);

  svc.reportReceipt({ receipt_no: "RCP-Y", action_id: action, channel_id: channel, content: { paused: true, re_executed: true } });
  svc.confirmReceipt({ receipt_no: "RCP-Y", confirmed_by: "ops-2" });
  assert.equal(svc.getAction(action).status, "receipt_confirmed");
});

test("确认后才出现同号异议：确认状态不被推翻，异议另开调查挂账", () => {
  const svc = newService();
  seedWorld(svc);
  const { action, channel } = decidedPauseCase(svc);
  svc.reportReceipt({ receipt_no: "RCP-Z", action_id: action, channel_id: channel, content: { paused: true } });
  svc.confirmReceipt({ receipt_no: "RCP-Z", confirmed_by: "ops-1" });
  assert.equal(svc.getAction(action).status, "receipt_confirmed");

  const later = svc.reportReceipt({ receipt_no: "RCP-Z", action_id: action, channel_id: channel, content: { paused: false } });
  assert.equal(later.outcome, "investigation_opened");
  assert.equal(later.prior_status_preserved, true);
  assert.equal(svc.getAction(action).status, "receipt_confirmed", "已确认回执不得被后到内容降级或覆盖");
  assert.ok(svc.getAction(action).receipt.investigation_id, "异议仍须留下调查项");
});

test("回执编号不得跨处置动作混用", () => {
  const svc = newService();
  seedWorld(svc);
  openRetirement(svc, "RC-1", "timeline-map", "2.3.0");
  dualSign(svc, "RC-1");
  svc.decideDisposals("RC-1", [
    { exhibit_id: "EX-A", kind: "pause", note: "暂停" },
    { exhibit_id: "EX-B", kind: "pause", note: "暂停" },
  ]);
  svc.dispatchBatch("RC-1");
  svc.reportReceipt({ receipt_no: "SHARED", action_id: "DA-RC-1-EX-A", channel_id: "CH-A", content: { x: 1 } });
  assert.throws(
    () => svc.reportReceipt({ receipt_no: "SHARED", action_id: "DA-RC-1-EX-B", channel_id: "CH-B", content: { x: 2 } }),
    /已属于另一处置动作/,
  );
});
