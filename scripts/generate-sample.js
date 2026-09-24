#!/usr/bin/env node
/**
 * 生成一条可本地复现的组件退役传播事件流：data/sample-stream.jsonl
 *
 * 场景：互动问答组件 3.1.0 因学术来源撤回被发起退役；三个展项分别
 * 暂停、替换、补充说明；随后第二次更正（3.2.0）与第一批交错发生，
 * 后批排除前批未确认动作影响的展项；渠道用同一回执号上报不同内容，
 * 系统开立调查项而非覆盖。
 *
 * 运行：node scripts/generate-sample.js
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

import { EventStore } from "../src/store.js";
import { RegistryService } from "../src/registry.js";
import { RetirementService } from "../src/retirement.js";
import { traceFromRelease } from "../src/lineage.js";

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "..", "data", "sample-stream.jsonl");
rmSync(outFile, { force: true });

// 确定性时钟与编号，保证生成物可复现。
let minutes = 0;
const base = Date.parse("2026-09-20T09:00:00+08:00");
let counter = 0;
const clock = {
  now: () => new Date(base + minutes++ * 60_000).toISOString(),
  newId: (prefix) => `${prefix}-${(++counter).toString().padStart(3, "0")}`,
};

const store = new EventStore(outFile);
const registry = new RegistryService(store, clock);
const retirement = new RetirementService(store, clock);

// 组件谱系 3.0.0 -> 3.1.0 -> 3.2.0。
registry.registerComponent({ component_id: "C-quiz", name: "互动问答组件", description: "多展项复用的互动问答" });
registry.releaseVersion({ component_id: "C-quiz", release_id: "rel-3.0.0", version: "3.0.0", parent_release_id: null });
registry.releaseVersion({ component_id: "C-quiz", release_id: "rel-3.1.0", version: "3.1.0", parent_release_id: "rel-3.0.0" });
registry.releaseVersion({ component_id: "C-quiz", release_id: "rel-3.2.0", version: "3.2.0", parent_release_id: "rel-3.1.0" });

// 3.1.0 同时运行在三个展项；学术来源撤回。
registry.deploy({ exhibit_id: "E-历史大厅", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "大厅触摸屏" });
registry.deploy({ exhibit_id: "E-数字官网", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "官网" });
registry.deploy({ exhibit_id: "E-移动导览", release_id: "rel-3.1.0", component_id: "C-quiz", component_version: "3.1.0", channel: "移动端" });
const withdrawal = registry.withdrawSource({
  source_id: "S-JR-2026-042",
  reason_code: "JOURNAL_RETRACTION",
  reason_detail: "所引研究被期刊撤回，声明含错误引导",
  withdrawn_by: "学术秘书处",
});

// 第一批退役：冻结范围、紧急阻断大厅、三种处置分别双签决定。
const r1 = retirement.initiate({
  component_id: "C-quiz",
  component_version: "3.1.0",
  reason_code: "SOURCE_WITHDRAWN",
  reason_detail: "来源撤回，逐展项评估暂停、替换或补充说明",
  source_event_id: withdrawal.event_id,
  initiator: "平台主管-赵",
});
const [iHall, iWeb, iMobile] = [...r1.items.keys()];
retirement.emergencyBlock({
  retirement_id: r1.retirement_id,
  reason_code: "IMMEDIATE_HARM_RISK",
  reason_detail: "撤回声明含错误引导，先阻断大厅命中组件",
  exhibit_ids: ["E-历史大厅"],
});
const decide = (itemId, plan) => {
  retirement.submitPlan({ retirement_id: r1.retirement_id, item_id: itemId, submitted_by: "项目负责人-钱", ...plan });
  retirement.sign({ retirement_id: r1.retirement_id, item_id: itemId, role: "ACADEMIC", signer: "学术委员-孙", note: "学术影响可接受" });
  retirement.sign({ retirement_id: r1.retirement_id, item_id: itemId, role: "LEGAL", signer: "法务-李", note: "授权与合规确认" });
};
decide(iHall, { plan_kind: "PAUSE", note: "立即下线，等待整批素材更换" });
decide(iWeb, { plan_kind: "REPLACE", replacement_release_id: "rel-3.2.0", note: "移除撤回素材并升级到 3.2.0" });
decide(iMobile, { plan_kind: "ADDENDUM", note: "授权范围与撤回内容无关，补充来源状态说明后继续运行" });

// 大厅与移动端先回执完成；官网回执未到——前批存在未确认动作。
retirement.reportExecution({ retirement_id: r1.retirement_id, item_id: iHall, receipt_no: "RC-20260920-001", channel: "大厅触摸屏", action: "PAUSE", content: "问答互动已暂停，屏保画面接管" });
retirement.reportExecution({ retirement_id: r1.retirement_id, item_id: iMobile, receipt_no: "RC-20260920-002", channel: "移动端", action: "ADDENDUM", content: "导览说明页已补充授权与来源撤回状态" });

// 第二次更正到来：3.2.0 已在官网与大厅上线，发起第二批退役。
registry.deploy({ exhibit_id: "E-数字官网", release_id: "rel-3.2.0", component_id: "C-quiz", component_version: "3.2.0", channel: "官网" });
registry.deploy({ exhibit_id: "E-历史大厅", release_id: "rel-3.2.0", component_id: "C-quiz", component_version: "3.2.0", channel: "大厅触摸屏" });
const r2 = retirement.initiate({
  component_id: "C-quiz",
  component_version: "3.2.0",
  reason_code: "SECOND_CORRECTION",
  reason_detail: "素材勘误第二次更正，须更换图示",
  initiator: "平台主管-赵",
});
// 官网在 R1 的动作尚未确认 → 被排除；大厅前批已完成 → 入批处置。
const [iHall32] = [...r2.items.keys()];
retirement.submitPlan({ retirement_id: r2.retirement_id, item_id: iHall32, plan_kind: "REPLACE", replacement_release_id: "rel-3.2.0", note: "大厅更换勘误后的图示素材", submitted_by: "项目负责人-钱" });
retirement.sign({ retirement_id: r2.retirement_id, item_id: iHall32, role: "ACADEMIC", signer: "学术委员-孙" });
retirement.sign({ retirement_id: r2.retirement_id, item_id: iHall32, role: "LEGAL", signer: "法务-李" });

// 交错回头：官网第一批替换回执到达；同回执号被另一渠道误报不同内容 → 调查项。
retirement.reportExecution({ retirement_id: r1.retirement_id, item_id: iWeb, receipt_no: "RC-20260920-003", channel: "官网", action: "REPLACE", content: "官网已升级 rel-3.2.0 并移除撤回素材" });
const conflict = retirement.reportExecution({
  retirement_id: r2.retirement_id,
  item_id: iHall32,
  receipt_no: "RC-20260920-003",
  channel: "大厅触摸屏",
  action: "REPLACE",
  content: "大厅上报了与官网同号但完全不同的执行内容",
});
retirement.resolveInvestigation({
  investigation_id: conflict.investigation_id,
  resolution: "CANONICAL_RECEIPT",
  note: "渠道回执串号，官网首条记录为真实执行，大厅需凭新回执号补报",
});
// 大厅凭正确回执号补报完成第二批。
retirement.reportExecution({ retirement_id: r2.retirement_id, item_id: iHall32, receipt_no: "RC-20260920-004", channel: "大厅触摸屏", action: "REPLACE", content: "大厅图示素材已更换为勘误版本" });

retirement.closeBatch({ retirement_id: r1.retirement_id });
retirement.closeBatch({ retirement_id: r2.retirement_id });

const events = store.all();
const trace = traceFromRelease(events, "rel-3.1.0");
console.log(`已写出 ${events.length} 条事件到 ${outFile}`);
console.log(`R1 冻结 ${r1.items.size} 项；R2 冻结 ${r2.items.size} 项，排除 ${r2.excluded.length} 项（${r2.excluded[0]?.exhibit_id} 受 ${r2.excluded[0]?.blocking_retirement_id} 未确认动作影响）`);
console.log(`调查项 ${conflict.investigation_id} 已结论；rel-3.1.0 谱系：${trace.lineage.map((x) => x.release_id).join(" -> ")}`);
