import { Catalog, hashContent } from "./registry.js";

/** 退役批次互斥的影响范围键：同一组件在同一展项同一渠道上的一切版本。 */
function affectedScopeKey(componentId, exhibitId, channel) {
  return `${componentId}|${exhibitId}|${channel}`;
}

/**
 * 组件退役传播服务。
 *
 * 一个退役聚合（component_retirement）的生命周期：
 *   发起（选定组件版本与原因）
 *     → 冻结当时部署范围（命中且不受前批未确认动作影响的部署）
 *     → （可选）紧急阻断
 *     → 项目负责人逐展项提交替代方案
 *     → 学术、法务分别签署
 *     → 双签齐备后形成逐展项决定（暂停 / 替换 / 补充说明）
 *     → 渠道回执确认实际执行
 *   批次允许部分关闭：未完成项保留自身进度；
 *   同回执号不同内容只产生调查项，绝不覆盖已记录回执或谎报成功。
 */
export class RetirementService {
  /**
   * @param {import("./store.js").EventStore} store
   * @param {{ now?: () => string, newId?: (prefix: string) => string }} [options]
   */
  constructor(store, options = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? ((p) => `${p}-${Math.random().toString(16).slice(2, 10)}`);
    this.catalog = new Catalog();
    /** retirement_id -> 投影状态 */
    this.retirements = new Map();
    /** 回执编号 -> 首次记录的回执 */
    this.receiptIndex = new Map();
    /** investigation_id -> 调查项 */
    this.investigations = new Map();
    for (const event of store.all()) this._apply(event);
    // 此后由登记服务等任何入口追加的事件都同样进入投影，保证冻结范围看到最新部署。
    store.subscribe((event) => this._apply(event));
  }

  // ---------------------------------------------------------------- 投影

  _apply(event) {
    this.catalog.apply(event);
    const p = event.payload;
    switch (event.event_type) {
      case "RETIREMENT_INITIATED":
        this.retirements.set(p.retirement_id, {
          retirement_id: p.retirement_id,
          component_id: p.component_id,
          component_version: p.component_version,
          reason_code: p.reason_code,
          reason_detail: p.reason_detail,
          source_event_id: p.source_event_id ?? null,
          initiator: p.initiator,
          items: new Map(),
          excluded: [],
          blocks: [],
          batchClosures: [],
        });
        break;
      case "DEPLOYMENT_SCOPE_FROZEN": {
        const r = this.retirements.get(p.retirement_id);
        r.excluded = p.excluded;
        for (const item of p.items) {
          r.items.set(item.item_id, {
            ...item,
            status: "FROZEN",
            plan: null,
            signatures: new Map(),
            decision: null,
            receipt: null,
            conflict: null,
          });
        }
        break;
      }
      case "EMERGENCY_BLOCK_ISSUED": {
        const r = this.retirements.get(p.retirement_id);
        r.blocks.push({ at: event.occurred_at, reason_code: p.reason_code, hits: p.hits });
        for (const hit of p.hits) {
          const item = [...r.items.values()].find(
            (i) =>
              i.exhibit_id === hit.exhibit_id &&
              i.release_id === hit.release_id &&
              i.channel === hit.channel,
          );
          if (item && item.status === "FROZEN") item.status = "BLOCKED";
        }
        break;
      }
      case "REPLACEMENT_PLAN_SUBMITTED": {
        const item = this._item(p.retirement_id, p.item_id);
        if (item.status !== "FROZEN" && item.status !== "BLOCKED" && item.status !== "PLAN_SUBMITTED") {
          break;
        }
        if (item.status === "PLAN_SUBMITTED" && item.signatures.size > 0) break;
        item.plan = {
          plan_kind: p.plan_kind,
          replacement_release_id: p.replacement_release_id ?? null,
          note: p.note,
          submitted_by: p.submitted_by,
        };
        item.signatures = new Map();
        item.status = "PLAN_SUBMITTED";
        break;
      }
      case "RETIREMENT_SIGNED": {
        const item = this._item(p.retirement_id, p.item_id);
        item.signatures.set(p.role, { signer: p.signer, at: event.occurred_at });
        break;
      }
      case "RETIREMENT_ITEM_DECIDED": {
        const item = this._item(p.retirement_id, p.item_id);
        item.decision = {
          decision: p.decision,
          detail: p.detail,
          replacement_release_id: p.replacement_release_id ?? null,
          academic_signer: p.academic_signer,
          legal_signer: p.legal_signer,
          at: event.occurred_at,
        };
        item.status = "DECIDED";
        break;
      }
      case "EXECUTION_RECEIPT_RECORDED": {
        this.receiptIndex.set(p.receipt_no, { ...p });
        const item = this._item(p.retirement_id, p.item_id);
        item.receipt = {
          receipt_no: p.receipt_no,
          channel: p.channel,
          action: p.action,
          content_hash: p.content_hash,
          at: event.occurred_at,
          event_id: event.event_id,
        };
        item.status = "COMPLETED";
        break;
      }
      case "RECEIPT_CONFLICT_FLAGGED": {
        this.investigations.set(p.investigation_id, {
          investigation_id: p.investigation_id,
          retirement_id: p.retirement_id,
          item_id: p.item_id,
          receipt_no: p.receipt_no,
          open: true,
        });
        const reporter = this._item(p.retirement_id, p.item_id);
        reporter.conflict = {
          investigation_id: p.investigation_id,
          reporter: true,
          status_before: reporter.status,
          at: event.occurred_at,
        };
        reporter.status = "CONFLICT";
        const recorder = this._item(p.recorded_retirement_id, p.recorded_item_id);
        if (recorder && recorder !== reporter && recorder.status !== "CONFLICT") {
          recorder.conflict = {
            investigation_id: p.investigation_id,
            reporter: false,
            status_before: recorder.status,
            at: event.occurred_at,
          };
          recorder.status = "CONFLICT";
        }
        break;
      }
      case "INVESTIGATION_RESOLVED": {
        const inv = this.investigations.get(p.investigation_id);
        inv.open = false;
        inv.resolution = p.resolution;
        const conflictEvent = this.store
          .all()
          .find(
            (e) =>
              e.event_type === "RECEIPT_CONFLICT_FLAGGED" &&
              e.payload.investigation_id === p.investigation_id,
          );
        const cp = conflictEvent.payload;
        const recorder = this._item(cp.recorded_retirement_id, cp.recorded_item_id);
        const reporter = this._item(cp.retirement_id, cp.item_id);
        // 冲突开立时双方都记下了冲突前状态；结论只是恢复现场，历史事件不动。
        if (recorder && recorder.conflict) {
          recorder.status = recorder.conflict.status_before;
          recorder.conflict = null;
        }
        if (reporter && reporter !== recorder && reporter.conflict) {
          reporter.status = reporter.conflict.status_before;
          reporter.conflict = null;
        }
        break;
      }
      case "RETIREMENT_BATCH_CLOSED": {
        this.retirements.get(p.retirement_id).batchClosures.push({
          at: event.occurred_at,
          completed: p.completed.slice(),
          outstanding: p.outstanding.map((o) => ({ ...o })),
        });
        break;
      }
      default:
        break;
    }
  }

  _item(retirementId, itemId) {
    const r = this.retirements.get(retirementId);
    const item = r?.items.get(itemId);
    if (!item) throw new Error(`退役 ${retirementId} 中不存在处置项 ${itemId}`);
    return item;
  }

  /**
   * 前批尚未完成（动作未确认或仍在调查中）的影响范围。
   * 粒度为 组件|展项|渠道：同一展项同一渠道上，同一组件旧版本的处置尚未确认时，
   * 连其升级版本的新部署也一并视为受影响，必须等前批收口。
   */
  _outstandingScopes(exceptRetirementId = null) {
    const keys = new Set();
    for (const [rid, r] of this.retirements) {
      if (rid === exceptRetirementId) continue;
      for (const item of r.items.values()) {
        if (item.status !== "COMPLETED") {
          keys.add(affectedScopeKey(r.component_id, item.exhibit_id, item.channel));
        }
      }
    }
    return keys;
  }

  _emit(eventType, aggregateType, aggregateId, summary, payload, version) {
    const event = {
      event_id: this.newId("evt"),
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.now(),
      version: version ?? this.store.nextVersion(aggregateId),
      summary,
      payload,
    };
    this.store.append(event);
    return event;
  }

  // ---------------------------------------------------------------- 命令

  /**
   * 发起人选定组件版本与原因；系统立即冻结当时的部署范围。
   * 前批未确认动作所影响的部署进入 excluded，本批不得处理。
   */
  initiate({ component_id, component_version, reason_code, reason_detail, source_event_id, initiator }) {
    const retirement_id = this.newId("R");

    // 先计算冻结范围：冻结发生在发起事件落库之前，保证范围快照不被本批后续动作影响。
    const outstanding = this._outstandingScopes(retirement_id);
    const items = [];
    const excluded = [];
    let n = 0;
    for (const dep of this.catalog.activeDeployments(component_id, component_version)) {
      const scope = affectedScopeKey(component_id, dep.exhibit_id, dep.channel);
      if (outstanding.has(scope)) {
        const blocker = this._findBlockingRetirement(scope, retirement_id);
        excluded.push({
          exhibit_id: dep.exhibit_id,
          release_id: dep.release_id,
          component_version: dep.component_version,
          channel: dep.channel,
          reason_code: "PRIOR_UNCONFIRMED_ACTION",
          blocking_retirement_id: blocker,
        });
        continue;
      }
      n += 1;
      items.push({
        item_id: `${retirement_id}-I${n}`,
        exhibit_id: dep.exhibit_id,
        release_id: dep.release_id,
        component_version: dep.component_version,
        channel: dep.channel,
        deployed_at: dep.deployed_at,
      });
    }
    if (items.length === 0 && excluded.length === 0) {
      throw new Error(`组件 ${component_id}@${component_version} 当前没有命中的运行部署，无可冻结范围`);
    }

    this._emit(
      "RETIREMENT_INITIATED",
      "component_retirement",
      retirement_id,
      `发起组件退役：${component_id}@${component_version}（${reason_code}）`,
      {
        retirement_id,
        component_id,
        component_version,
        reason_code,
        reason_detail,
        source_event_id,
        initiator,
      },
      1,
    );

    this._emit(
      "DEPLOYMENT_SCOPE_FROZEN",
      "component_retirement",
      retirement_id,
      `冻结 ${items.length} 个命中部署，排除 ${excluded.length} 个受前批未确认动作影响的部署`,
      { retirement_id, component_id, component_version, items, excluded },
      2,
    );
    return this.retirements.get(retirement_id);
  }

  _findBlockingRetirement(scope, exceptRetirementId) {
    for (const [rid, r] of this.retirements) {
      if (rid === exceptRetirementId) continue;
      for (const item of r.items.values()) {
        if (
          item.status !== "COMPLETED" &&
          affectedScopeKey(r.component_id, item.exhibit_id, item.channel) === scope
        ) {
          return rid;
        }
      }
    }
    return null;
  }

  /** 紧急风险：先阻断命中的组件（无需等待签署）。 */
  emergencyBlock({ retirement_id, reason_code, reason_detail, exhibit_ids = null }) {
    const r = this.retirements.get(retirement_id);
    if (!r) throw new Error(`退役不存在：${retirement_id}`);
    const hits = [];
    for (const item of r.items.values()) {
      if (item.status !== "FROZEN") continue;
      if (exhibit_ids && !exhibit_ids.includes(item.exhibit_id)) continue;
      hits.push({ exhibit_id: item.exhibit_id, release_id: item.release_id, channel: item.channel });
    }
    if (hits.length === 0) throw new Error("没有处于冻结态、可紧急阻断的命中项");
    return this._emit(
      "EMERGENCY_BLOCK_ISSUED",
      "component_retirement",
      retirement_id,
      `紧急阻断 ${hits.length} 个命中部署`,
      {
        retirement_id,
        component_id: r.component_id,
        component_version: r.component_version,
        reason_code,
        reason_detail,
        hits,
      },
    );
  }

  /** 项目负责人针对单个展项提交处置方案。 */
  submitPlan({ retirement_id, item_id, plan_kind, replacement_release_id, note, submitted_by }) {
    const item = this._item(retirement_id, item_id);
    if (!["FROZEN", "BLOCKED", "PLAN_SUBMITTED"].includes(item.status)) {
      throw new Error(`处置项当前状态 ${item.status} 不允许提交方案`);
    }
    if (item.status === "PLAN_SUBMITTED" && item.signatures.size > 0) {
      throw new Error("已有签署记录，方案不得更换");
    }
    if (!["PAUSE", "REPLACE", "ADDENDUM"].includes(plan_kind)) {
      throw new Error(`未知处置形态：${plan_kind}`);
    }
    if (plan_kind === "REPLACE" && !replacement_release_id) {
      throw new Error("替换方案必须给出 replacement_release_id");
    }
    return this._emit(
      "REPLACEMENT_PLAN_SUBMITTED",
      "component_retirement",
      retirement_id,
      `展项 ${item.exhibit_id} 提交${{ PAUSE: "暂停", REPLACE: "替换", ADDENDUM: "补充说明" }[plan_kind]}方案`,
      { retirement_id, item_id, exhibit_id: item.exhibit_id, plan_kind, replacement_release_id, note, submitted_by },
    );
  }

  /** 学术 / 法务分别签署；双签齐备即形成该展项的处置决定。 */
  sign({ retirement_id, item_id, role, signer, note }) {
    if (role !== "ACADEMIC" && role !== "LEGAL") throw new Error(`未知签署角色：${role}`);
    const item = this._item(retirement_id, item_id);
    if (item.status !== "PLAN_SUBMITTED") throw new Error(`处置项当前状态 ${item.status}，须先提交方案`);
    if (item.signatures.has(role)) throw new Error(`${role} 已签署，不得重复签署`);

    const signEvent = this._emit(
      "RETIREMENT_SIGNED",
      "component_retirement",
      retirement_id,
      `${role === "ACADEMIC" ? "学术" : "法务"}签署展项 ${item.exhibit_id} 的处置方案`,
      { retirement_id, item_id, exhibit_id: item.exhibit_id, role, signer, note },
    );
    if (item.signatures.size === 2) {
      this._emit(
        "RETIREMENT_ITEM_DECIDED",
        "component_retirement",
        retirement_id,
        `双签齐备，展项 ${item.exhibit_id} 决定${{ PAUSE: "暂停", REPLACE: "替换", ADDENDUM: "补充说明继续运行" }[item.plan.plan_kind]}`,
        {
          retirement_id,
          item_id,
          exhibit_id: item.exhibit_id,
          decision: item.plan.plan_kind,
          detail: item.plan.note,
          replacement_release_id: item.plan.replacement_release_id ?? undefined,
          academic_signer: item.signatures.get("ACADEMIC").signer,
          legal_signer: item.signatures.get("LEGAL").signer,
        },
      );
    }
    return signEvent;
  }

  /**
   * 渠道上报执行回执。
   * content 为执行内容原文，服务自行计算指纹比对。
   */
  reportExecution({ retirement_id, item_id, receipt_no, channel, action, content }) {
    const item = this._item(retirement_id, item_id);
    const content_hash = hashContent(content);

    const recorded = this.receiptIndex.get(receipt_no);
    const sameReport =
      recorded &&
      recorded.content_hash === content_hash &&
      recorded.action === action &&
      recorded.channel === channel;
    const ownRecord =
      recorded && recorded.retirement_id === retirement_id && recorded.item_id === item_id;

    // 同一处置项重复上报完全相同的内容：幂等忽略，不产生新事件。
    if (ownRecord && sameReport) {
      return { duplicate: true, event: null };
    }
    // 调查未决期间，任何新异义一律拒绝。
    if (item.status === "CONFLICT") {
      throw new Error("该处置项存在未决调查项，调查结论前不得上报新执行内容");
    }
    // 尚未形成双签决定的处置项不具备回执上报资格。
    if (item.status !== "DECIDED" && item.status !== "COMPLETED") {
      throw new Error(`处置项当前状态 ${item.status}，双签决定尚未形成`);
    }
    // 回执编号已存在但内容不一致、或指向另一个处置项——包括已完成项被再次异报——
    // 都只开立调查项：绝不覆盖首次记录，也不谎报成功。
    if (recorded) {
      const investigation_id = this.newId("inv");
      const conflictEvent = this._emit(
        "RECEIPT_CONFLICT_FLAGGED",
        "component_retirement",
        retirement_id,
        `回执 ${receipt_no} 上报内容与已记录执行不一致，开立调查项 ${investigation_id}`,
        {
          investigation_id,
          retirement_id,
          item_id,
          exhibit_id: item.exhibit_id,
          receipt_no,
          channel,
          received_content_hash: content_hash,
          recorded_content_hash: recorded.content_hash,
          recorded_retirement_id: recorded.retirement_id,
          recorded_item_id: recorded.item_id,
        },
      );
      return { duplicate: false, conflict: true, event: conflictEvent, investigation_id };
    }
    if (item.status === "COMPLETED") {
      throw new Error(`展项已凭回执 ${item.receipt.receipt_no} 确认完成，异义须走调查流程`);
    }
    if (action !== item.decision.decision) {
      throw new Error(`执行动作 ${action} 与决定 ${item.decision.decision} 不一致`);
    }
    if (channel !== item.channel) {
      throw new Error(`上报渠道 ${channel} 与冻结部署渠道 ${item.channel} 不一致`);
    }

    const event = this._emit(
      "EXECUTION_RECEIPT_RECORDED",
      "component_retirement",
      retirement_id,
      `展项 ${item.exhibit_id} 执行 ${action}，回执 ${receipt_no} 确认`,
      { retirement_id, item_id, exhibit_id: item.exhibit_id, receipt_no, channel, action, content_hash },
    );
    return { duplicate: Boolean(recorded), conflict: false, event };
  }

  /** 调查结论：正本回执成立或误报丢弃，都不改动历史事件。 */
  resolveInvestigation({ investigation_id, resolution, note }) {
    const inv = this.investigations.get(investigation_id);
    if (!inv) throw new Error(`调查项不存在：${investigation_id}`);
    if (!inv.open) throw new Error(`调查项 ${investigation_id} 已结论`);
    if (!["CANONICAL_RECEIPT", "REPORT_DISCARDED"].includes(resolution)) {
      throw new Error(`未知调查结论：${resolution}`);
    }
    return this._emit(
      "INVESTIGATION_RESOLVED",
      "component_retirement",
      inv.retirement_id,
      `调查项 ${investigation_id} 结论：${resolution}`,
      { investigation_id, retirement_id: inv.retirement_id, item_id: inv.item_id, resolution, note },
    );
  }

  /** 部分关闭批次：完成项收口，未完成项保留自身进度。 */
  closeBatch({ retirement_id }) {
    const r = this.retirements.get(retirement_id);
    if (!r) throw new Error(`退役不存在：${retirement_id}`);
    const completed = [];
    const outstanding = [];
    for (const item of r.items.values()) {
      if (item.status === "COMPLETED") completed.push(item.item_id);
      else outstanding.push({ item_id: item.item_id, exhibit_id: item.exhibit_id, status: item.status });
    }
    return this._emit(
      "RETIREMENT_BATCH_CLOSED",
      "component_retirement",
      retirement_id,
      `批次部分关闭：完成 ${completed.length} 项，遗留 ${outstanding.length} 项`,
      { retirement_id, completed, outstanding },
    );
  }

  // ---------------------------------------------------------------- 查询

  getRetirement(retirementId) {
    return this.retirements.get(retirementId);
  }

  /** 展项当前处置进度（跨所有退役批次），服务重启后同样可查。 */
  progressByExhibit() {
    const out = new Map();
    for (const r of this.retirements.values()) {
      for (const item of r.items.values()) {
        const list = out.get(item.exhibit_id) ?? [];
        list.push({
          retirement_id: r.retirement_id,
          item_id: item.item_id,
          component_version: item.component_version,
          status: item.status,
          decision: item.decision?.decision ?? null,
          receipt_no: item.receipt?.receipt_no ?? null,
        });
        out.set(item.exhibit_id, list);
      }
    }
    return out;
  }
}
