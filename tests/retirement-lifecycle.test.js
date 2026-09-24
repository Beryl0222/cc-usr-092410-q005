import assert from "node:assert/strict";
import test from "node:test";

import { newService, seedWorld, openRetirement, dualSign } from "./helpers/fixture.js";

function setup() {
  const svc = newService();
  seedWorld(svc);
  return svc;
}

test("完整退役生命周期：发起→冻结→替代方案→双签→决定→批次→回执核验", () => {
  const svc = setup();
  const frozen = openRetirement(svc, "RC-1", "timeline-map", "2.3.0");

  // 冻结时刻命中 timeline-map@2.3.0 的是 EX-A、EX-B；EX-C/EX-D 不在命中范围。
  const affected = frozen.frozen_scope.deployments.filter((d) => d.affected).map((d) => d.exhibit_id).sort();
  assert.deepEqual(affected, ["EX-A", "EX-B"]);
  const exB = frozen.frozen_scope.deployments.find((d) => d.exhibit_id === "EX-B");
  assert.deepEqual(exB.in_service_components.sort(), ["quiz-wheel@1.2.0", "timeline-map@2.3.0"]);

  // EX-B 选择更换素材，先提交替代方案；EX-A 稍后决定暂停。
  svc.submitReplacement({ case_id: "RC-1", exhibit_id: "EX-B", owner_id: "owner-b", replacement_ref: "timeline-map@2.4.0", note: "升级到干净版本" });

  // 双签缺失时不能形成决定。
  svc.signOff("RC-1", "academic", { signer: "prof.wang" });
  assert.throws(() => svc.decideDisposals("RC-1", [{ exhibit_id: "EX-A", kind: "pause", note: "立即暂停" }]), /法务签署缺失/);
  svc.signOff("RC-1", "legal", { signer: "legal.li" });

  const decided = svc.decideDisposals("RC-1", [
    { exhibit_id: "EX-A", kind: "pause", note: "立即暂停，等待复核" },
    { exhibit_id: "EX-B", kind: "replace", note: "升级到 2.4.0" },
  ]);
  const kinds = Object.fromEntries(decided.decisions.map((d) => [d.exhibit_id, d.kind]));
  assert.deepEqual(kinds, { "EX-A": "pause", "EX-B": "replace" });
  assert.equal(decided.decisions.find((d) => d.exhibit_id === "EX-B").replacement_ref, "timeline-map@2.4.0");

  // 决定一经形成不得重做（第二次更正不能覆盖第一次）。
  assert.throws(
    () => svc.decideDisposals("RC-1", [{ exhibit_id: "EX-A", kind: "annotate", note: "改主意" }]),
    /已形成处置决定/,
  );
});

test("处置方式守卫：替换须先有替代方案；补充说明须给内容；不得对未命中展项作决定", () => {
  const svc = setup();
  openRetirement(svc, "RC-1", "timeline-map", "2.3.0");
  dualSign(svc, "RC-1");

  assert.throws(() => svc.decideDisposals("RC-1", [{ exhibit_id: "EX-A", kind: "replace" }]), /尚未提交替代方案/);
  assert.throws(() => svc.decideDisposals("RC-1", [{ exhibit_id: "EX-A", kind: "annotate" }]), /须给出说明内容/);
  assert.throws(() => svc.decideDisposals("RC-1", [{ exhibit_id: "EX-C", kind: "pause", note: "x" }]), /不在冻结的命中范围/);
});

test("批次允许部分成功：关闭时只确认已核验项，未完成项保留进度并进入下一批", () => {
  const svc = setup();
  openRetirement(svc, "RC-1", "timeline-map", "2.3.0");
  svc.submitReplacement({ case_id: "RC-1", exhibit_id: "EX-B", owner_id: "owner-b", replacement_ref: "timeline-map@2.4.0" });
  dualSign(svc, "RC-1");
  svc.decideDisposals("RC-1", [
    { exhibit_id: "EX-A", kind: "pause", note: "暂停" },
    { exhibit_id: "EX-B", kind: "replace", note: "升级" },
  ]);

  const batch1 = svc.dispatchBatch("RC-1");
  assert.deepEqual(batch1.requested.sort(), ["DA-RC-1-EX-A", "DA-RC-1-EX-B"]);

  // 只有 EX-A 上报且核验通过；EX-B 尚未回执。
  svc.reportReceipt({ receipt_no: "RCP-1", action_id: "DA-RC-1-EX-A", channel_id: "CH-A", content: { paused: true } });
  svc.confirmReceipt({ receipt_no: "RCP-1", confirmed_by: "ops-1" });

  const close1 = svc.closeBatch("RC-1", "B-RC-1-1", "首批：A 已停，B 待素材");
  assert.deepEqual(close1.confirmed_at_close, ["DA-RC-1-EX-A"]);
  assert.deepEqual(close1.pending_at_close, ["DA-RC-1-EX-B"]);

  // EX-A 已确认、EX-B 仍是已下发未完成：未完成项进度保留。
  assert.equal(svc.getAction("DA-RC-1-EX-A").status, "receipt_confirmed");
  assert.equal(svc.getAction("DA-RC-1-EX-B").status, "requested");

  // 已下发动作不能重复纳入批次；EX-B 完成后无需再下发，直接回执核验即可。
  assert.throws(() => svc.dispatchBatch("RC-1", { action_ids: ["DA-RC-1-EX-A"] }), /不可纳入本批/);
  svc.reportReceipt({ receipt_no: "RCP-2", action_id: "DA-RC-1-EX-B", channel_id: "CH-B", content: { replaced_to: "timeline-map@2.4.0" } });
  svc.confirmReceipt({ receipt_no: "RCP-2", confirmed_by: "ops-1" });
  assert.equal(svc.getAction("DA-RC-1-EX-B").status, "receipt_confirmed");

  // 批次关闭结果不可改写。
  assert.throws(() => svc.closeBatch("RC-1", "B-RC-1-1", "再关一次"), /已关闭/);
});

test("授权范围不受影响：annotate 决定补充说明后展项可继续运行", () => {
  const svc = setup();
  openRetirement(svc, "RC-1", "timeline-map", "2.3.0");
  dualSign(svc, "RC-1");
  svc.decideDisposals("RC-1", [
    { exhibit_id: "EX-A", kind: "annotate", note: "该展项使用片段在授权例外范围内，加注来源状态后继续运行" },
    { exhibit_id: "EX-B", kind: "pause", note: "暂停" },
  ]);
  svc.dispatchBatch("RC-1", { action_ids: ["DA-RC-1-EX-A", "DA-RC-1-EX-B"] });
  svc.reportReceipt({ receipt_no: "RCP-A", action_id: "DA-RC-1-EX-A", channel_id: "CH-A", content: { annotated: true } });
  svc.confirmReceipt({ receipt_no: "RCP-A", confirmed_by: "ops-1" });
  const view = svc.describeCase("RC-1");
  const a = view.decisions.find((d) => d.exhibit_id === "EX-A");
  assert.equal(a.kind, "annotate");
  assert.equal(a.execution.status, "receipt_confirmed");
});

test("未冻结/替代方案只接受命中范围；冻结不可重做", () => {
  const svc = setup();
  svc.initiateRetirement({ case_id: "RC-1", component_id: "timeline-map", component_version: "2.3.0", reason: "撤回", initiator: "sup" });
  assert.throws(() => svc.submitReplacement({ case_id: "RC-1", exhibit_id: "EX-A", owner_id: "o", replacement_ref: "x" }), /尚未冻结/);
  svc.freezeScope("RC-1");
  assert.throws(() => svc.freezeScope("RC-1"), /冻结不得重做/);
  assert.throws(() => svc.submitReplacement({ case_id: "RC-1", exhibit_id: "EX-D", owner_id: "o", replacement_ref: "x" }), /未命中被退役版本/);
});
