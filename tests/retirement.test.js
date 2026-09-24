import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { EventStore } from "../src/store.js";
import { RegistryService, hashContent } from "../src/registry.js";
import { RetirementService } from "../src/retirement.js";
import { traceFromRelease } from "../src/lineage.js";

/** 确定性时钟与编号，便于断言顺序。 */
function harness() {
  let counter = 0;
  let minutes = 0;
  const base = new Date("2026-09-20T09:00:00+08:00").getTime();
  return {
    now: () => new Date(base + minutes++ * 60_000).toISOString(),
    newId: (prefix) => `${prefix}-${(++counter).toString().padStart(3, "0")}`,
  };
}

function buildServices(file = ":memory:") {
  const h = harness();
  const store = new EventStore(file);
  const registry = new RegistryService(store, h);
  const retirement = new RetirementService(store, h);
  return { h, store, registry, retirement };
}

/** 登记组件并发布一条带谱系的版本链：rel-3.0.0 <- rel-3.1.0 <- rel-3.2.0。 */
function seedComponent(registry) {
  registry.registerComponent({ component_id: "C-quiz", name: "互动问答组件" });
  registry.releaseVersion({
    component_id: "C-quiz",
    release_id: "rel-3.0.0",
    version: "3.0.0",
    parent_release_id: null,
  });
  registry.releaseVersion({
    component_id: "C-quiz",
    release_id: "rel-3.1.0",
    version: "3.1.0",
    parent_release_id: "rel-3.0.0",
  });
  registry.releaseVersion({
    component_id: "C-quiz",
    release_id: "rel-3.2.0",
    version: "3.2.0",
    parent_release_id: "rel-3.1.0",
  });
}

/** 项目负责人提交方案，学术与法务依次签署，形成决定。 */
function decideItem(retirement, r, itemId, plan, submittedBy = "项目负责人") {
  retirement.submitPlan({ retirement_id: r, item_id: itemId, submitted_by: submittedBy, ...plan });
  retirement.sign({ retirement_id: r, item_id: itemId, role: "ACADEMIC", signer: "学术委员-甲" });
  retirement.sign({ retirement_id: r, item_id: itemId, role: "LEGAL", signer: "法务-乙" });
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retirement-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ 全流程

test("发起退役冻结当时部署范围，双签后形成暂停/替换/补充说明三种决定并以回执收口", () => {
  const { registry, retirement } = buildServices();
  seedComponent(registry);
  registry.deploy({ exhibit_id: "E-大厅", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "大厅触摸屏" });
  registry.deploy({ exhibit_id: "E-官网", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "官网" });
  registry.deploy({ exhibit_id: "E-移动端", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "移动端" });
  const withdrawal = registry.withdrawSource({
    source_id: "S-042",
    reason_code: "JOURNAL_RETRACTION",
    reason_detail: "所引研究被期刊撤回",
    withdrawn_by: "学术秘书处",
  });

  const r1 = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "SOURCE_WITHDRAWN",
    reason_detail: "来源撤回，逐展项评估",
    source_event_id: withdrawal.event_id,
    initiator: "平台主管",
  });

  assert.equal(r1.items.size, 3);
  assert.deepEqual(r1.excluded, []);
  const frozenItemIds = [...r1.items.keys()];

  // 冻结之后新增的同版本部署不进入本批范围。
  registry.deploy({ exhibit_id: "E-临展", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "临展屏" });
  assert.equal(retirement.getRetirement(r1.retirement_id).items.size, 3);

  const [iHall, iWeb, iMobile] = frozenItemIds;

  // 紧急风险先阻断，无需签署。
  retirement.emergencyBlock({
    retirement_id: r1.retirement_id,
    reason_code: "IMMEDIATE_HARM_RISK",
    reason_detail: "撤回声明含有害引导",
    exhibit_ids: ["E-大厅"],
  });
  assert.equal(r1.items.get(iHall).status, "BLOCKED");

  // 三种处置：大厅暂停、官网替换到 3.2.0、移动端授权不受影响仅补充说明。
  decideItem(retirement, r1.retirement_id, iHall, { plan_kind: "PAUSE", note: "立即下线，等待素材整批更换" });
  decideItem(retirement, r1.retirement_id, iWeb, {
    plan_kind: "REPLACE",
    replacement_release_id: "rel-3.2.0",
    note: "更换撤回素材并升级组件",
  });
  decideItem(retirement, r1.retirement_id, iMobile, {
    plan_kind: "ADDENDUM",
    note: "授权范围与引用内容无关，补充说明后继续运行",
  });

  assert.equal(r1.items.get(iHall).decision.decision, "PAUSE");
  assert.equal(r1.items.get(iWeb).decision.decision, "REPLACE");
  assert.equal(r1.items.get(iWeb).decision.replacement_release_id, "rel-3.2.0");
  assert.equal(r1.items.get(iMobile).decision.decision, "ADDENDUM");
  assert.equal(r1.items.get(iHall).decision.academic_signer, "学术委员-甲");
  assert.equal(r1.items.get(iHall).decision.legal_signer, "法务-乙");

  // 执行动作必须与决定一致，渠道必须与冻结部署一致。
  assert.throws(
    () =>
      retirement.reportExecution({
        retirement_id: r1.retirement_id,
        item_id: iHall,
        receipt_no: "RC-1",
        channel: "大厅触摸屏",
        action: "REPLACE",
        content: "错按替换执行",
      }),
    /与决定 PAUSE 不一致/,
  );

  const res1 = retirement.reportExecution({
    retirement_id: r1.retirement_id,
    item_id: iHall,
    receipt_no: "RC-1001",
    channel: "大厅触摸屏",
    action: "PAUSE",
    content: "问答互动已暂停，屏保画面接管",
  });
  assert.equal(res1.conflict, false);
  assert.equal(r1.items.get(iHall).status, "COMPLETED");

  retirement.reportExecution({
    retirement_id: r1.retirement_id,
    item_id: iWeb,
    receipt_no: "RC-1002",
    channel: "官网",
    action: "REPLACE",
    content: "已替换为 rel-3.2.0 并移除撤回素材",
  });
  retirement.reportExecution({
    retirement_id: r1.retirement_id,
    item_id: iMobile,
    receipt_no: "RC-1003",
    channel: "移动端",
    action: "ADDENDUM",
    content: "展项说明页已补充授权与来源状态说明",
  });
  for (const id of frozenItemIds) assert.equal(r1.items.get(id).status, "COMPLETED");
});

test("学术与法务须分别签署：单签不成决定，同一角色不得重签，签署后方案不得更换", () => {
  const { registry, retirement } = buildServices();
  seedComponent(registry);
  registry.deploy({ exhibit_id: "E1", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch" });
  const r = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "SOURCE_WITHDRAWN",
    reason_detail: "x",
    initiator: "主管",
  });
  const [item] = [...r.items.keys()];

  retirement.submitPlan({ retirement_id: r.retirement_id, item_id: item, plan_kind: "PAUSE", note: "n", submitted_by: "负责人" });
  retirement.sign({ retirement_id: r.retirement_id, item_id: item, role: "ACADEMIC", signer: "甲" });
  assert.equal(r.items.get(item).status, "PLAN_SUBMITTED");
  assert.equal(r.items.get(item).decision, null);

  assert.throws(
    () => retirement.sign({ retirement_id: r.retirement_id, item_id: item, role: "ACADEMIC", signer: "甲2" }),
    /ACADEMIC 已签署/,
  );
  assert.throws(
    () => retirement.submitPlan({ retirement_id: r.retirement_id, item_id: item, plan_kind: "REPLACE", replacement_release_id: "rel-3.2.0", note: "改", submitted_by: "负责人" }),
    /已有签署记录/,
  );

  retirement.sign({ retirement_id: r.retirement_id, item_id: item, role: "LEGAL", signer: "乙" });
  assert.equal(r.items.get(item).status, "DECIDED");
  assert.equal(r.items.get(item).decision.decision, "PAUSE");
});

// ------------------------------------------------------------ 不可变性

test("旧发布记录与已确认回执不可改写：后续动作只追加，历史事件保持原样", () => {
  const { store, registry, retirement } = buildServices();
  seedComponent(registry);
  registry.deploy({ exhibit_id: "E1", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch" });
  const releaseEvent = store.all().find((e) => e.event_type === "COMPONENT_RELEASED" && e.payload.release_id === "rel-3.1.0");
  const releaseSnapshot = JSON.stringify(releaseEvent);

  const r = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "SOURCE_WITHDRAWN",
    reason_detail: "x",
    initiator: "主管",
  });
  const [item] = [...r.items.keys()];
  decideItem(retirement, r.retirement_id, item, { plan_kind: "PAUSE", note: "n" });
  const receipt = retirement.reportExecution({
    retirement_id: r.retirement_id,
    item_id: item,
    receipt_no: "RC-9",
    channel: "ch",
    action: "PAUSE",
    content: "已暂停",
  });
  const receiptSnapshot = JSON.stringify(receipt.event);
  const streamLenBefore = store.all().length;

  // 第二次更正到来：紧急阻断与新退役都只追加事件。
  registry.deploy({ exhibit_id: "E2", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch" });
  const r2 = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "SECOND_WITHDRAWAL",
    reason_detail: "第二次更正",
    initiator: "主管",
  });
  retirement.emergencyBlock({
    retirement_id: r2.retirement_id,
    reason_code: "NEW_RISK",
    reason_detail: "二次撤回",
  });

  assert.ok(store.all().length > streamLenBefore);
  assert.equal(JSON.stringify(store.byAggregate("C-quiz").find((e) => e.event_id === releaseEvent.event_id)), releaseSnapshot);
  assert.equal(
    JSON.stringify(store.all().find((e) => e.event_id === receipt.event.event_id)),
    receiptSnapshot,
  );

  // 存储层本身拒绝重号与版本断裂。
  assert.throws(() => store.append({ ...releaseEvent, summary: "被篡改" }), /事件编号重复/);
  assert.throws(
    () =>
      store.append({
        event_id: "evt-bad",
        event_type: "THESIS_SUBMITTED",
        aggregate_type: "curatorial_thesis",
        aggregate_id: "ghost",
        occurred_at: "2026-09-21T00:00:00+08:00",
        version: 5,
        summary: "版本断裂",
        payload: {},
      }),
    /版本断裂/,
  );
});

// ------------------------------------------------------------ 部分成功

test("批次允许部分成功，未完成项保留自身进度并可继续收口", () => {
  const { registry, retirement } = buildServices();
  seedComponent(registry);
  registry.deploy({ exhibit_id: "E1", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch1" });
  registry.deploy({ exhibit_id: "E2", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch2" });
  registry.deploy({ exhibit_id: "E3", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch3" });
  const r = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "SOURCE_WITHDRAWN",
    reason_detail: "x",
    initiator: "主管",
  });
  const [i1, i2, i3] = [...r.items.keys()];

  // E1 完整完成；E2 已双签决定但回执未到；E3 只提交了方案。
  decideItem(retirement, r.retirement_id, i1, { plan_kind: "PAUSE", note: "1" });
  decideItem(retirement, r.retirement_id, i2, { plan_kind: "ADDENDUM", note: "2" });
  retirement.submitPlan({ retirement_id: r.retirement_id, item_id: i3, plan_kind: "PAUSE", note: "3", submitted_by: "负责人" });
  retirement.reportExecution({ retirement_id: r.retirement_id, item_id: i1, receipt_no: "RC-A", channel: "ch1", action: "PAUSE", content: "E1 已暂停" });

  retirement.closeBatch({ retirement_id: r.retirement_id });
  const closure = r.batchClosures.at(-1);
  assert.deepEqual(closure.completed, [i1]);
  assert.deepEqual(
    closure.outstanding.map((o) => [o.item_id, o.status]),
    [[i2, "DECIDED"], [i3, "PLAN_SUBMITTED"]],
  );

  // 未完成项保留各自进度：E2 直接补回执；E3 从签署继续，不必重交方案。
  retirement.reportExecution({ retirement_id: r.retirement_id, item_id: i2, receipt_no: "RC-B", channel: "ch2", action: "ADDENDUM", content: "E2 已补充说明" });
  retirement.sign({ retirement_id: r.retirement_id, item_id: i3, role: "ACADEMIC", signer: "甲" });
  retirement.sign({ retirement_id: r.retirement_id, item_id: i3, role: "LEGAL", signer: "乙" });
  retirement.reportExecution({ retirement_id: r.retirement_id, item_id: i3, receipt_no: "RC-C", channel: "ch3", action: "PAUSE", content: "E3 已暂停" });
  for (const id of [i1, i2, i3]) assert.equal(r.items.get(id).status, "COMPLETED");
});

// ------------------------------------------------------------ 相邻批次交错

test("两次相邻退役交错发生：后批只处理不受前批未确认动作影响的范围，顺序不被打乱", () => {
  const { store, registry, retirement } = buildServices();
  seedComponent(registry);

  // 3.1.0 部署在 E1、E2；之后组件升级，3.2.0 也部署到 E1、E2。
  registry.deploy({ exhibit_id: "E1", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch" });
  registry.deploy({ exhibit_id: "E2", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch" });

  // 第一批退役针对 3.1.0。
  const r1 = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "SOURCE_WITHDRAWN",
    reason_detail: "第一次更正",
    initiator: "主管",
  });
  const [r1e1, r1e2] = [...r1.items.keys()];
  decideItem(retirement, r1.retirement_id, r1e1, { plan_kind: "PAUSE", note: "E1 暂停" });
  retirement.reportExecution({ retirement_id: r1.retirement_id, item_id: r1e1, receipt_no: "RC-1", channel: "ch", action: "PAUSE", content: "R1-E1 暂停完成" });
  // E2 留在 FROZEN：前批存在未确认动作。

  // 3.2.0 在两展项上线，第二次更正到来，第二批退役针对 3.2.0。
  registry.deploy({ exhibit_id: "E1", release_id: "rel-3.2.0", component_id: "C-quiz", component_version: "3.2.0", channel: "ch" });
  registry.deploy({ exhibit_id: "E2", release_id: "rel-3.2.0", component_id: "C-quiz", component_version: "3.2.0", channel: "ch" });
  const r2 = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.2.0",
    reason_code: "SECOND_CORRECTION",
    reason_detail: "第二次更正",
    initiator: "主管",
  });

  // E1 的前批动作已确认 → 入批；E2 的前批动作未确认 → 排除并记录阻断批次。
  const r2Items = [...r2.items.values()];
  assert.deepEqual(r2Items.map((i) => i.exhibit_id), ["E1"]);
  assert.equal(r2.excluded.length, 1);
  assert.equal(r2.excluded[0].exhibit_id, "E2");
  assert.equal(r2.excluded[0].blocking_retirement_id, r1.retirement_id);
  const r2FrozenSnapshot = JSON.stringify([...r2.items.values()].map((i) => i.item_id));
  const r2ExcludedSnapshot = JSON.stringify(r2.excluded);
  const [r2e1] = [...r2.items.keys()];

  // 交错推进：第二批 E1 走到已决定但未执行；此时回头完成第一批 E2。
  decideItem(retirement, r2.retirement_id, r2e1, {
    plan_kind: "REPLACE",
    replacement_release_id: "rel-3.2.0",
    note: "更换素材",
  });
  assert.equal(r2.items.get(r2e1).status, "DECIDED");
  decideItem(retirement, r1.retirement_id, r1e2, { plan_kind: "REPLACE", replacement_release_id: "rel-3.2.0", note: "E2 升级替换" });
  retirement.reportExecution({ retirement_id: r1.retirement_id, item_id: r1e2, receipt_no: "RC-2", channel: "ch", action: "REPLACE", content: "R1-E2 替换完成" });
  assert.equal(r1.items.get(r1e2).status, "COMPLETED");

  // 第一批收口不回溯改写第二批的冻结范围与排除记录。
  assert.equal(JSON.stringify([...r2.items.keys()]), r2FrozenSnapshot);
  assert.equal(JSON.stringify(r2.excluded), r2ExcludedSnapshot);

  // 第三批：R2 的 E1 动作仍未确认 → 3.2.0/E1 仍排除；E2 前批已确认 → 现在可以入批。
  const r3 = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.2.0",
    reason_code: "THIRD_CORRECTION",
    reason_detail: "素材再次更换",
    initiator: "主管",
  });
  assert.deepEqual([...r3.items.values()].map((i) => i.exhibit_id), ["E2"]);
  assert.equal(r3.excluded[0].exhibit_id, "E1");
  assert.equal(r3.excluded[0].blocking_retirement_id, r2.retirement_id);

  // 顺序不变量：全局 seq 单调；每个退役聚合的 version 连续无缺号。
  const events = store.all();
  for (let i = 1; i < events.length; i += 1) assert.ok(events[i].seq > events[i - 1].seq);
  for (const rid of [r1.retirement_id, r2.retirement_id, r3.retirement_id]) {
    const versions = store.byAggregate(rid).map((e) => e.version);
    assert.deepEqual(versions, versions.map((_, i) => i + 1));
  }
  // 交错证据：R1 的回执 RC-2 落在 R2 冻结事件之后。
  const seqFreezeR2 = events.find((e) => e.event_type === "DEPLOYMENT_SCOPE_FROZEN" && e.payload.retirement_id === r2.retirement_id).seq;
  const seqRc2 = events.find((e) => e.event_type === "EXECUTION_RECEIPT_RECORDED" && e.payload.receipt_no === "RC-2").seq;
  assert.ok(seqRc2 > seqFreezeR2);

  // 交错结束后各方继续收口。
  retirement.reportExecution({ retirement_id: r2.retirement_id, item_id: r2e1, receipt_no: "RC-3", channel: "ch", action: "REPLACE", content: "R2-E1 替换完成" });
  const [r3e2] = [...r3.items.keys()];
  decideItem(retirement, r3.retirement_id, r3e2, { plan_kind: "PAUSE", note: "E2 暂停" });
  retirement.reportExecution({ retirement_id: r3.retirement_id, item_id: r3e2, receipt_no: "RC-4", channel: "ch", action: "PAUSE", content: "R3-E2 暂停完成" });

  // 从被排除的 3.2.0/E2 上线版本也能追到“它为何没进 R2”。
  const trace32 = traceFromRelease(store.all(), "rel-3.2.0");
  const e2view = trace32.deployed_on.find((d) => d.exhibit_id === "E2");
  assert.deepEqual(e2view.excluded_from, [
    { retirement_id: r2.retirement_id, reason_code: "PRIOR_UNCONFIRMED_ACTION", blocking_retirement_id: r1.retirement_id },
  ]);
});

// ------------------------------------------------------------ 回执冲突

test("同一回执编号上报不同执行内容：开立调查项，不覆盖、不误报，结论后恢复现场", () => {
  const { store, registry, retirement } = buildServices();
  seedComponent(registry);
  registry.deploy({ exhibit_id: "E1", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch1" });
  registry.deploy({ exhibit_id: "E2", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch2" });
  const r = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "SOURCE_WITHDRAWN",
    reason_detail: "x",
    initiator: "主管",
  });
  const [i1, i2] = [...r.items.keys()];
  decideItem(retirement, r.retirement_id, i1, { plan_kind: "PAUSE", note: "1" });
  decideItem(retirement, r.retirement_id, i2, { plan_kind: "PAUSE", note: "2" });

  const first = retirement.reportExecution({
    retirement_id: r.retirement_id,
    item_id: i1,
    receipt_no: "RC-DUP",
    channel: "ch1",
    action: "PAUSE",
    content: "E1 真实执行内容",
  });
  assert.equal(first.conflict, false);
  const firstReceiptEvent = first.event;
  const firstReceiptSnapshot = JSON.stringify(firstReceiptEvent);

  // 完全相同的重报：幂等，不新增事件。
  const streamLen = store.all().length;
  const again = retirement.reportExecution({
    retirement_id: r.retirement_id,
    item_id: i1,
    receipt_no: "RC-DUP",
    channel: "ch1",
    action: "PAUSE",
    content: "E1 真实执行内容",
  });
  assert.equal(again.duplicate, true);
  assert.equal(store.all().length, streamLen);

  // 另一处置项用同一回执号上报不同内容：只产生调查项。
  const conflict = retirement.reportExecution({
    retirement_id: r.retirement_id,
    item_id: i2,
    receipt_no: "RC-DUP",
    channel: "ch2",
    action: "PAUSE",
    content: "E2 完全不同的执行内容",
  });
  assert.equal(conflict.conflict, true);
  assert.ok(conflict.investigation_id);
  assert.equal(r.items.get(i1).status, "CONFLICT");
  assert.equal(r.items.get(i2).status, "CONFLICT");

  // 首次回执事件原样保留；没有为第二次上报新增回执事件。
  assert.equal(JSON.stringify(store.all().find((e) => e.event_id === firstReceiptEvent.event_id)), firstReceiptSnapshot);
  assert.equal(
    store.all().filter((e) => e.event_type === "EXECUTION_RECEIPT_RECORDED" && e.payload.receipt_no === "RC-DUP").length,
    1,
  );

  // 调查未决期间不得再上报。
  assert.throws(
    () =>
      retirement.reportExecution({
        retirement_id: r.retirement_id,
        item_id: i2,
        receipt_no: "RC-NEW",
        channel: "ch2",
        action: "PAUSE",
        content: "再试一次",
      }),
    /未决调查/,
  );

  // 结论确认首次回执为正本：记录方恢复完成，上报方回到决定态，可凭新回执号补报。
  retirement.resolveInvestigation({
    investigation_id: conflict.investigation_id,
    resolution: "CANONICAL_RECEIPT",
    note: "渠道串号，首条记录为真实执行",
  });
  assert.equal(r.items.get(i1).status, "COMPLETED");
  assert.equal(r.items.get(i2).status, "DECIDED");
  const fixed = retirement.reportExecution({
    retirement_id: r.retirement_id,
    item_id: i2,
    receipt_no: "RC-REAL-2",
    channel: "ch2",
    action: "PAUSE",
    content: "E2 真实执行内容",
  });
  assert.equal(fixed.conflict, false);
  assert.equal(r.items.get(i2).status, "COMPLETED");
});

test("同回执号同内容但指向另一处置项，同样进入调查而非二次确认", () => {
  const { registry, retirement } = buildServices();
  seedComponent(registry);
  registry.deploy({ exhibit_id: "E1", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch1" });
  registry.deploy({ exhibit_id: "E2", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch2" });
  const r = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "X",
    reason_detail: "x",
    initiator: "主管",
  });
  const [i1, i2] = [...r.items.keys()];
  decideItem(retirement, r.retirement_id, i1, { plan_kind: "PAUSE", note: "1" });
  decideItem(retirement, r.retirement_id, i2, { plan_kind: "PAUSE", note: "2" });
  retirement.reportExecution({ retirement_id: r.retirement_id, item_id: i1, receipt_no: "RC-X", channel: "ch1", action: "PAUSE", content: "相同文本" });
  const out = retirement.reportExecution({ retirement_id: r.retirement_id, item_id: i2, receipt_no: "RC-X", channel: "ch2", action: "PAUSE", content: "相同文本" });
  assert.equal(out.conflict, true);
});

test("已完成项以同一回执号上报不同内容：同样开立调查，原回执不改写，结论后维持完成", () => {
  const { store, registry, retirement } = buildServices();
  seedComponent(registry);
  registry.deploy({ exhibit_id: "E1", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch1" });
  const r = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "X",
    reason_detail: "x",
    initiator: "主管",
  });
  const [i1] = [...r.items.keys()];
  decideItem(retirement, r.retirement_id, i1, { plan_kind: "PAUSE", note: "1" });
  const first = retirement.reportExecution({ retirement_id: r.retirement_id, item_id: i1, receipt_no: "RC-100", channel: "ch1", action: "PAUSE", content: "原始执行内容" });
  const beforeLen = store.all().length;
  const firstHash = first.event.payload.content_hash;

  const out = retirement.reportExecution({ retirement_id: r.retirement_id, item_id: i1, receipt_no: "RC-100", channel: "ch1", action: "PAUSE", content: "事后被改报的不同内容" });
  assert.equal(out.conflict, true);
  assert.equal(r.items.get(i1).status, "CONFLICT");

  // 原回执事件保持原样，未新增第二条回执。
  assert.equal(store.all().find((e) => e.event_id === first.event.event_id).payload.content_hash, firstHash);
  assert.equal(store.all().filter((e) => e.event_type === "EXECUTION_RECEIPT_RECORDED").length, 1);

  retirement.resolveInvestigation({ investigation_id: out.investigation_id, resolution: "CANONICAL_RECEIPT", note: "渠道重放误报，以首条为准" });
  assert.equal(r.items.get(i1).status, "COMPLETED");
  assert.equal(store.all().length, beforeLen + 2); // 冲突事件 + 调查结论事件
});

// ------------------------------------------------------------ 重启续跑

test("服务重启后从各展项进度继续，状态完全由事件流重建", () => {
  const file = join(dir, "events.jsonl");
  const h = harness();
  const store1 = new EventStore(file);
  const registry1 = new RegistryService(store1, h);
  const svc1 = new RetirementService(store1, h);
  seedComponent(registry1);
  registry1.deploy({ exhibit_id: "E1", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch1" });
  registry1.deploy({ exhibit_id: "E2", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "ch2" });
  const r = svc1.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "SOURCE_WITHDRAWN",
    reason_detail: "x",
    initiator: "主管",
  });
  const [i1, i2] = [...r.items.keys()];
  decideItem(svc1, r.retirement_id, i1, { plan_kind: "PAUSE", note: "1" });
  svc1.reportExecution({ retirement_id: r.retirement_id, item_id: i1, receipt_no: "RC-1", channel: "ch1", action: "PAUSE", content: "E1 done" });
  decideItem(svc1, r.retirement_id, i2, { plan_kind: "PAUSE", note: "2" });
  const progressBefore = JSON.stringify([...svc1.progressByExhibit().entries()].sort());

  // —— 模拟服务重启 ——
  // 重启后编号器从历史最大编号之后继续（事件/退役/调查共用同一计数序列）。
  const maxSeqNo = Math.max(
    0,
    ...store1.all().flatMap((e) =>
      [e.event_id, e.aggregate_id, e.payload?.retirement_id, e.payload?.investigation_id]
        .filter(Boolean)
        .map((id) => Number(String(id).split("-").at(-1)) || 0),
    ),
  );
  let counter2 = maxSeqNo;
  let minutes2 = 0;
  const base2 = new Date("2026-09-21T09:00:00+08:00").getTime();
  const h2 = {
    now: () => new Date(base2 + minutes2++ * 60_000).toISOString(),
    newId: (prefix) => `${prefix}-${(++counter2).toString().padStart(3, "0")}`,
  };
  const store2 = new EventStore(file);
  // 重放得到的事件编号与 seq 与重启前完全一致。
  assert.deepEqual(
    store2.all().map((e) => [e.event_id, e.seq]),
    store1.all().map((e) => [e.event_id, e.seq]),
  );
  const svc2 = new RetirementService(store2, h2);
  assert.deepEqual(JSON.stringify([...svc2.progressByExhibit().entries()].sort()), progressBefore);
  assert.equal(svc2.getRetirement(r.retirement_id).items.get(i1).status, "COMPLETED");
  assert.equal(svc2.getRetirement(r.retirement_id).items.get(i2).status, "DECIDED");

  // 从 E2 既有进度继续：不必重走方案与签署。
  svc2.reportExecution({ retirement_id: r.retirement_id, item_id: i2, receipt_no: "RC-2", channel: "ch2", action: "PAUSE", content: "E2 done" });
  assert.equal(svc2.getRetirement(r.retirement_id).items.get(i2).status, "COMPLETED");
  assert.equal(store2.all().length, store1.all().length + 1);
});

// ------------------------------------------------------------ 谱系追溯

test("从任一上线版本可追到谱系、证据变化、签署决定与实际执行", () => {
  const { store, registry, retirement } = buildServices();
  seedComponent(registry);
  registry.deploy({ exhibit_id: "E-大厅", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "大厅触摸屏" });
  registry.deploy({ exhibit_id: "E-官网", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "官网" });
  const withdrawal = registry.withdrawSource({
    source_id: "S-042",
    reason_code: "JOURNAL_RETRACTION",
    reason_detail: "期刊撤回",
    withdrawn_by: "学术秘书处",
  });
  const r = retirement.initiate({
    component_id: "C-quiz",
    component_version: "3.1.0",
    reason_code: "SOURCE_WITHDRAWN",
    reason_detail: "来源撤回",
    source_event_id: withdrawal.event_id,
    initiator: "主管",
  });
  const items = [...r.items.keys()];
  decideItem(retirement, r.retirement_id, items[0], { plan_kind: "PAUSE", note: "大厅暂停" });
  decideItem(retirement, r.retirement_id, items[1], {
    plan_kind: "REPLACE",
    replacement_release_id: "rel-3.2.0",
    note: "官网替换",
  });
  retirement.reportExecution({ retirement_id: r.retirement_id, item_id: items[0], receipt_no: "RC-1", channel: "大厅触摸屏", action: "PAUSE", content: "暂停完成" });
  retirement.reportExecution({ retirement_id: r.retirement_id, item_id: items[1], receipt_no: "RC-2", channel: "官网", action: "REPLACE", content: "替换完成" });
  registry.deploy({ exhibit_id: "E-官网", release_id: "rel-3.2.0", component_id: "C-quiz", component_version: "3.2.0", channel: "官网" });

  // 从被退役版本追溯。
  const trace = traceFromRelease(store.all(), "rel-3.1.0");
  assert.deepEqual(trace.lineage.map((x) => x.release_id), ["rel-3.1.0", "rel-3.0.0"]);
  assert.equal(trace.deployed_on.length, 2);
  const hall = trace.deployed_on.find((d) => d.exhibit_id === "E-大厅");
  assert.equal(hall.retirement_trail.length, 1);
  const trail = hall.retirement_trail[0];
  assert.equal(trail.evidence_withdrawal.source_id, "S-042");
  assert.deepEqual(trail.signatures.map((s) => s.role).sort(), ["ACADEMIC", "LEGAL"]);
  assert.equal(trail.decision.decision, "PAUSE");
  assert.equal(trail.receipts[0].receipt_no, "RC-1");
  assert.equal(trail.receipts[0].content_hash, hashContent("暂停完成"));

  // 从替代后上线的新版本同样可追到同一谱系与自身部署。
  const trace32 = traceFromRelease(store.all(), "rel-3.2.0");
  assert.deepEqual(trace32.lineage.map((x) => x.release_id), ["rel-3.2.0", "rel-3.1.0", "rel-3.0.0"]);
  assert.equal(trace32.deployed_on[0].exhibit_id, "E-官网");
  // 新版本反向可见它是由官网那批退役的替换决定引入的。
  assert.equal(trace32.introduced_by_replacements.length, 1);
  assert.equal(trace32.introduced_by_replacements[0].exhibit_id, "E-官网");
  assert.equal(trace32.introduced_by_replacements[0].retirement_id, r.retirement_id);

  // 追溯结果在重启（仅事件流）后一致。
  const file = join(dir, "events.jsonl");
  writeFileSync(file, store.all().map((e) => JSON.stringify(e)).join("\n") + "\n");
  const restartedStore = new EventStore(file);
  const traceAfterRestart = traceFromRelease(restartedStore.all(), "rel-3.1.0");
  assert.equal(traceAfterRestart.deployed_on.length, 2);
});

test("无命中部署时发起退役被拒绝，不产生任何事件", () => {
  const { store, registry, retirement } = buildServices();
  seedComponent(registry);
  const before = store.all().length;
  assert.throws(
    () =>
      retirement.initiate({
        component_id: "C-quiz",
        component_version: "9.9.9",
        reason_code: "X",
        reason_detail: "x",
        initiator: "主管",
      }),
    /没有命中的运行部署/,
  );
  assert.equal(store.all().length, before);
});
