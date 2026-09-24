import { createHash } from "node:crypto";
import { EventStore } from "./event-store.js";
import { Projections } from "./projections.js";

/**
 * 组件退役平台服务（事件溯源）。
 *
 * 流程：发起人选定组件版本与原因 -> 冻结当时部署范围（排除前案未确认动作涉及的展项）
 *   -> 项目负责人提交替代方案 -> 学术、法务分别签署 -> 形成每个展项的
 *   暂停(pause)/替换(replace)/补充说明继续运行(annotate)决定
 *   -> 分批次下发，允许部分成功，未完成项保留进度 -> 渠道回执确认。
 *
 * 横切规则：
 * - 紧急阻断可立即命中组件，但只追加阻断事件，不改写旧发布记录与已确认回执。
 * - 同一回执编号上报不同执行内容：追加报告并开调查项，动作不计成功、原内容不被覆盖。
 * - 后一批退役冻结范围时，凡存在前案未确认处置动作（含调查未结）的展项一律排除。
 * - 所有状态都是事件的投影；用同一事件存储重建服务即等价于“服务重启后续跑”。
 */
export class RetirementService {
  #store;
  #view;
  #now;

  constructor(store = new EventStore(), { now = () => new Date().toISOString() } = {}) {
    this.#store = store instanceof EventStore ? store : new EventStore(store);
    this.#now = now;
    this.#view = new Projections();
    for (const event of this.#store.all()) this.#view.apply(event);
  }

  get store() {
    return this.#store;
  }

  #emit(type, aggregate_type, aggregate_id, summary, payload, causation_id, correlation_id) {
    const event = this.#store.append(
      { event_type: type, aggregate_type, aggregate_id, summary, payload, causation_id, correlation_id },
      this.#now,
    );
    this.#view.apply(event);
    return event;
  }

  // ---------- 既有策展资料登记：命题、来源、发布、复用记录 ----------

  registerThesis({ thesis_id, title, owner_id }) {
    return this.#emit("THESIS_SUBMITTED", "curatorial_thesis", thesis_id, `登记策展命题：${title}`, {
      thesis_id,
      title,
      owner_id,
    });
  }

  clearSource({ source_id, title, rights_scope }) {
    return this.#emit("SOURCE_CLEARED", "research_asset", source_id, `学术来源核验通过：${title}`, {
      source_id,
      title,
      rights_scope,
    });
  }

  /** 学术来源撤回——退役发起的典型原因；旧核验记录保留，撤回是后继事件而非改写。 */
  withdrawSource({ source_id, reason }) {
    return this.#emit("SOURCE_WITHDRAWN", "research_asset", source_id, `学术来源撤回：${reason}`, {
      source_id,
      reason,
    });
  }

  releaseComponentVersion({ component_id, component_version, source_ids = [], predecessor = null, proposal_id = null }) {
    const id = `${component_id}@${component_version}`;
    return this.#emit("VERSION_RELEASED", "component_version", id, `组件发布 ${id}`, {
      component_id,
      component_version,
      source_ids,
      predecessor,
      proposal_id,
    });
  }

  /** 登记“某互动组件版本被某数字展项复用”的记录，是冻结部署范围的依据。 */
  registerReuse({ exhibit_id, exhibit_name, channel_id, proposal_id, component_id, component_version, source_ids = [], online_release = null }) {
    return this.#emit(
      "COMPONENT_REUSE_REGISTERED",
      "experience_proposal",
      exhibit_id,
      `展项 ${exhibit_name} 登记复用组件 ${component_id}@${component_version}`,
      {
        exhibit_id,
        exhibit_name,
        channel_id,
        proposal_id,
        component_id,
        component_version,
        source_ids,
        online_release,
      },
    );
  }

  // ---------- 紧急阻断 ----------

  /** 紧急风险：立即阻断命中的组件版本；不触碰任何旧发布记录或执行回执。 */
  urgentBlock({ block_id, component_id, component_version, reason, operator }) {
    const existing = [...this.#store.events({ aggregate_type: "urgent_block" })]
      .map((e) => e.payload)
      .find((p) => p.component_id === component_id && p.component_version === component_version);
    if (existing) throw new Error(`组件 ${component_id}@${component_version} 已存在紧急阻断 ${existing.block_id ?? ""}`);
    return this.#emit(
      "COMPONENT_BLOCKED_URGENTLY",
      "urgent_block",
      block_id,
      `紧急阻断 ${component_id}@${component_version}：${reason}`,
      { block_id, component_id, component_version, reason, operator },
    );
  }

  /** 当前上线内容命中紧急阻断的展项（可据此立刻暂停）。 */
  currentlyBlockedExhibits() {
    return this.#view.currentlyBlockedExhibits();
  }

  // ---------- 退役案 ----------

  initiateRetirement({ case_id, component_id, component_version, reason, reason_source_id = null, initiator }) {
    if (!case_id || !component_id || !component_version || !reason || !initiator) {
      throw new Error("发起退役须提供 case_id、组件版本、原因与发起人");
    }
    if (this.#view.getCase(case_id)) throw new Error(`退役案 ${case_id} 已存在`);

    // 若该版本此前已被紧急阻断，退役案自动关联阻断记录，证据链相连但互不改写。
    const related_blocks = [...this.#store.events({ aggregate_type: "urgent_block" })]
      .map((e) => e.payload)
      .filter((p) => p.component_id === component_id && p.component_version === component_version)
      .map((p) => p.block_id);

    this.#emit("RETIREMENT_INITIATED", "retirement_case", case_id, `发起退役 ${component_id}@${component_version}：${reason}`, {
      case_id,
      component_id,
      component_version,
      reason,
      reason_source_id,
      initiator,
      related_blocks,
    });
    return this.describeCase(case_id);
  }

  /**
   * 冻结发起时刻的部署范围。
   * 凡在其他退役案中存在未确认处置动作（含调查未结）的展项，排除出本批范围，
   * 保证后一批退役不处理受前一批未确认动作影响的范围。
   */
  freezeScope(case_id) {
    const c = this.#requireCase(case_id);
    if (c.frozen) throw new Error(`退役案 ${case_id} 已冻结部署范围，冻结不得重做`);

    const frozenAt = this.#now();
    const snapshots = [...this.#view.exhibits.entries()].map(([exhibit_id, entry]) => {
      const inService = [...entry.deployments.values()];
      const hit = inService.find((r) => r.component_id === c.component_id && r.component_version === c.component_version);
      return {
        exhibit_id,
        exhibit_name: entry.exhibit_name,
        channel_id: (hit ?? inService[0])?.channel_id ?? null,
        proposal_id: (hit ?? inService[0])?.proposal_id ?? null,
        in_service_components: inService.map((r) => `${r.component_id}@${r.component_version}`),
        deployed_component_version: hit ? `${hit.component_id}@${hit.component_version}` : null,
        affected: Boolean(hit),
        frozen_at: frozenAt,
      };
    });

    const excluded = [];
    const deployments = [];
    for (const snap of snapshots) {
      const blocking = this.#view.pendingActionsForExhibit(snap.exhibit_id).filter((a) => a.case_id !== case_id);
      if (blocking.length > 0) {
        excluded.push({ ...snap, blocking_action_ids: blocking.map((a) => a.action_id) });
      } else {
        deployments.push(snap);
      }
    }

    this.#emit(
      "DEPLOYMENT_SCOPE_FROZEN",
      "retirement_case",
      case_id,
      `冻结部署范围：${deployments.length} 个展项纳入，${excluded.length} 个因前案未确认动作排除`,
      { frozen_at: frozenAt, deployments, excluded },
    );
    return this.describeCase(case_id);
  }

  submitReplacement({ case_id, exhibit_id, owner_id, replacement_ref, note = "" }) {
    const c = this.#requireCase(case_id);
    this.#requireFrozenAffected(c, exhibit_id);
    if (!replacement_ref) throw new Error("替代方案必须给出 replacement_ref");
    return this.#emit(
      "REPLACEMENT_SUBMITTED",
      "retirement_case",
      case_id,
      `展项 ${exhibit_id} 提交替代方案 ${replacement_ref}`,
      { case_id, exhibit_id, owner_id, replacement_ref, note },
    );
  }

  signOff(case_id, role, { signer, note = "" }) {
    this.#requireCase(case_id);
    if (role !== "academic" && role !== "legal") throw new Error("签署角色只能是 academic 或 legal");
    const type = role === "academic" ? "SIGNED_OFF_BY_ACADEMIC" : "SIGNED_OFF_BY_LEGAL";
    const label = role === "academic" ? "学术" : "法务";
    return this.#emit(type, "retirement_case", case_id, `${label}签署：${signer}`, { case_id, role, signer, note });
  }

  /**
   * 学术与法务分别签署后，形成每个展项的处置决定。
   * entries: [{ exhibit_id, kind: pause|replace|annotate, note, replacement_ref? }]
   */
  decideDisposals(case_id, entries) {
    const c = this.#requireCase(case_id);
    if (!c.frozen) throw new Error("尚未冻结部署范围");
    if (c.academic_signoffs.length === 0) throw new Error("学术签署缺失，不能形成处置决定");
    if (c.legal_signoffs.length === 0) throw new Error("法务签署缺失，不能形成处置决定");
    if (c.decisions.length > 0) throw new Error(`退役案 ${case_id} 已形成处置决定；更正须走新的后继记录`);
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("至少需要一条处置决定");

    const affectedIds = new Set(c.frozen.deployments.filter((d) => d.affected).map((d) => d.exhibit_id));
    const decisions = entries.map((entry) => {
      if (!affectedIds.has(entry.exhibit_id)) {
        throw new Error(`展项 ${entry.exhibit_id} 不在冻结的命中范围内，不得对其作出决定`);
      }
      if (!["pause", "replace", "annotate"].includes(entry.kind)) {
        throw new Error(`处置方式非法：${entry.kind}`);
      }
      const snap = c.frozen.deployments.find((d) => d.exhibit_id === entry.exhibit_id);
      const action_id = `DA-${case_id}-${entry.exhibit_id}`;
      const replacements = c.replacements.get(entry.exhibit_id) ?? [];
      const latestReplacement = replacements.length ? replacements[replacements.length - 1] : null;
      const replacement_ref = entry.replacement_ref ?? latestReplacement?.replacement_ref ?? null;
      if (entry.kind === "replace" && !replacement_ref) {
        throw new Error(`展项 ${entry.exhibit_id} 决定替换但尚未提交替代方案`);
      }
      if (entry.kind === "annotate" && !entry.note) {
        throw new Error(`展项 ${entry.exhibit_id} 决定补充说明，须给出说明内容`);
      }
      return {
        action_id,
        exhibit_id: entry.exhibit_id,
        channel_id: snap.channel_id,
        kind: entry.kind,
        note: entry.note ?? "",
        replacement_ref,
      };
    });

    this.#emit("DISPOSAL_DECIDED", "retirement_case", case_id, `形成 ${decisions.length} 项处置决定`, {
      case_id,
      decisions,
    });
    return this.describeCase(case_id);
  }

  /**
   * 下发一个处置批次（可为任意已决定、尚未下发的动作子集）。
   * 下发后渠道在批内上报回执；关闭批次时只记录当时的部分成功情况，
   * 未完成项保留自身进度，可进入后续批次或继续等待回执。
   */
  dispatchBatch(case_id, { batch_id = null, action_ids = null, note = "" } = {}) {
    const c = this.#requireCase(case_id);
    if (c.decisions.length === 0) throw new Error("尚无处置决定，不能下发批次");

    const selectable = c.decisions
      .map((d) => this.#view.getAction(d.action_id))
      .filter((a) => a.status === "decided");
    const chosen = action_ids === null ? selectable : selectable.filter((a) => action_ids.includes(a.action_id));
    if (action_ids !== null) {
      const chosenSet = new Set(chosen.map((a) => a.action_id));
      const illegal = action_ids.filter((id) => !chosenSet.has(id));
      if (illegal.length) {
        throw new Error(`以下动作不可纳入本批（未决定或已下发）：${illegal.join(", ")}`);
      }
    }
    if (chosen.length === 0) throw new Error("本批没有可下发的处置动作");

    const seq = c.batches.size + 1;
    const bid = batch_id ?? `B-${case_id}-${seq}`;
    for (const a of chosen) {
      this.#emit(
        "DISPOSAL_REQUESTED",
        "disposal_action",
        a.action_id,
        `批次 ${bid} 下发：${a.exhibit_id} 执行 ${a.kind}`,
        { case_id, batch_id: bid, channel_id: a.channel_id, kind: a.kind, note },
        bid,
        case_id,
      );
    }
    return { batch_id: bid, requested: chosen.map((a) => a.action_id) };
  }

  /** 关闭批次：固化此刻部分成功/未完成快照；未完成项的状态不受影响，仍可继续推进。 */
  closeBatch(case_id, batch_id, summary = "") {
    const c = this.#requireCase(case_id);
    const batch = c.batches.get(batch_id);
    if (!batch) throw new Error(`批次不存在：${batch_id}`);
    if (batch.closed) throw new Error(`批次 ${batch_id} 已关闭，关闭结果不得改写`);

    const actions = batch.requested.map((id) => this.#view.getAction(id));
    const confirmed = actions.filter((a) => this.#view.isActionConfirmed(a)).map((a) => a.action_id);
    const pending = actions.filter((a) => !this.#view.isActionConfirmed(a)).map((a) => a.action_id);
    this.#emit(
      "DISPOSAL_BATCH_CLOSED",
      "retirement_case",
      case_id,
      `批次 ${batch_id} 关闭：${confirmed.length} 已确认，${pending.length} 未完成`,
      {
        case_id,
        batch_id,
        requested: batch.requested,
        confirmed_at_close: confirmed,
        pending_at_close: pending,
        summary,
      },
      batch_id,
    );
    return { batch_id, requested: batch.requested, confirmed_at_close: confirmed, pending_at_close: pending };
  }

  /**
   * 渠道以回执编号上报执行情况（首报仅登记待核，不代表成功）。
   * - 首次上报：登记回执，动作进入“已上报待核”。
   * - 同编号同内容：视为重复送达，忽略（不覆盖、不重复计成功）。
   * - 同编号不同内容：原报告原样保留并开调查项；
   *   · 动作尚未确认时不计成功、转入调查；
   *   · 动作已确认时确认状态不被推翻，调查作为后继异议挂账，须另行核查。
   */
  reportReceipt({ receipt_no, action_id, channel_id, content, exhibit_id = null }) {
    const action = this.#view.getAction(action_id);
    if (!action) throw new Error(`处置动作不存在：${action_id}`);
    if (!["requested", "receipt_reported", "under_investigation", "receipt_confirmed", "investigated_confirmed"].includes(action.status)) {
      throw new Error(`动作 ${action_id} 尚未下发，不能上报回执`);
    }

    const content_hash = hashContent(content);
    const existing = this.#view.receipts.get(receipt_no);
    const case_id = action.case_id;

    if (existing && existing.action_id !== action_id) {
      throw new Error(`回执编号 ${receipt_no} 已属于另一处置动作，拒绝混用`);
    }

    // 先快照既往报告：existing 是投影中的活引用，发事件后其 reports 会被原地追加。
    const priorReports = existing ? existing.reports.map((r) => ({ ...r })) : [];

    this.#emit(
      "EXECUTION_RECEIPT_REPORTED",
      "execution_receipt",
      receipt_no,
      `渠道 ${channel_id} 上报回执 ${receipt_no}（动作 ${action_id}）`,
      {
        receipt_no,
        case_id,
        action_id,
        exhibit_id: exhibit_id ?? action.exhibit_id,
        channel_id,
        content,
        content_hash,
        report_seq: priorReports.length + 1,
      },
      action_id,
      case_id,
    );

    if (priorReports.length === 0) {
      return { outcome: "reported", receipt_no, action_id, awaiting: "confirmation" };
    }

    const priorHashes = new Set(priorReports.map((r) => r.content_hash));
    if (priorHashes.has(content_hash)) {
      return { outcome: "ignored_duplicate", receipt_no, action_id };
    }

    // 同一回执编号出现不同执行内容：不覆盖、不误报成功，开调查项。
    const investigation_id = `INV-${receipt_no}-${priorReports.length + 1}`;
    this.#emit(
      "RECEIPT_DISCREPANCY_INVESTIGATION_OPENED",
      "receipt_investigation",
      investigation_id,
      `回执 ${receipt_no} 先后上报内容不一致，开立调查项`,
      {
        investigation_id,
        receipt_no,
        case_id,
        action_id,
        reason: "同一回执编号对应多份不同执行内容",
        reports: [...priorReports, { seq: priorReports.length + 1, channel_id, content, content_hash }],
      },
      receipt_no,
      case_id,
    );
    return {
      outcome: "investigation_opened",
      receipt_no,
      action_id,
      investigation_id,
      prior_status_preserved: this.#view.isActionConfirmed(action),
    };
  }

  /** 平台核验渠道回执无误后确认；确认后该执行即定案，后继异议只能另开调查、不得改写。 */
  confirmReceipt({ receipt_no, confirmed_by, note = "" }) {
    const receipt = this.#view.receipts.get(receipt_no);
    if (!receipt) throw new Error(`回执不存在：${receipt_no}`);
    const action = this.#view.getAction(receipt.action_id);
    const investigation = receipt.investigation_id ? this.#view.investigations.get(receipt.investigation_id) : null;
    if (investigation && investigation.status === "open") {
      throw new Error(`回执 ${receipt_no} 存在未结调查项，须先作出调查结论`);
    }
    if (investigation && investigation.status === "resolved" && investigation.resolution.confirmed === false) {
      throw new Error(`回执 ${receipt_no} 的执行已被调查否定，须以新的回执编号重新上报`);
    }
    if (this.#view.isActionConfirmed(action)) {
      throw new Error(`回执 ${receipt_no} 已确认，确认不得改写`);
    }
    if (receipt.reports.length === 0) throw new Error(`回执 ${receipt_no} 尚无上报内容`);
    const latest = receipt.reports[receipt.reports.length - 1];
    this.#emit(
      "EXECUTION_RECEIPT_CONFIRMED",
      "execution_receipt",
      receipt_no,
      `回执 ${receipt_no} 经 ${confirmed_by} 核验确认`,
      { receipt_no, case_id: receipt.case_id, action_id: receipt.action_id, confirmed_by, note, report_seq: latest.seq },
      receipt_no,
      receipt.case_id,
    );
    return this.getAction(receipt.action_id);
  }

  /** 调查结论：confirmed=true 则动作确认完成；false 则退回待重报，渠道须以新回执重新上报。 */
  resolveInvestigation({ investigation_id, confirmed, resolution_note, resolver }) {
    const inv = this.#view.investigations.get(investigation_id);
    if (!inv) throw new Error(`调查项不存在：${investigation_id}`);
    if (inv.status === "resolved") throw new Error(`调查项 ${investigation_id} 已有结论，结论不得改写`);
    const receipt = this.#view.receipts.get(inv.receipt_no);
    this.#emit(
      "INVESTIGATION_RESOLVED",
      "receipt_investigation",
      investigation_id,
      `调查项 ${investigation_id} 结论：${confirmed ? "确认执行属实" : "执行不成立，退回重报"}`,
      { investigation_id, confirmed, resolution_note, resolver },
      inv.receipt_no,
      receipt.case_id,
    );
    return this.getAction(receipt.action_id);
  }

  // ---------- 查询 ----------

  describeCase(case_id) {
    return this.#view.describeCase(this.#requireCase(case_id));
  }

  getCase(case_id) {
    const c = this.#view.getCase(case_id);
    return c ? this.describeCase(case_id) : null;
  }

  getAction(action_id) {
    const a = this.#view.getAction(action_id);
    if (!a) return null;
    return {
      ...a,
      receipt: a.receipt_no ? this.#view.receipts.get(a.receipt_no) : null,
      investigation: a.investigation_id ? this.#view.investigations.get(a.investigation_id) : null,
    };
  }

  /** 从任一上线版本追溯组件谱系、证据变化、签署决定与实际执行。 */
  trace(query) {
    return this.#view.trace(query);
  }

  /** 用同一事件存储重建服务：重放全部事件，进度与调查项原样恢复。 */
  static reboot(store, options) {
    return new RetirementService(store, options);
  }

  // ---------- 内部 ----------

  #requireCase(case_id) {
    const c = this.#view.getCase(case_id);
    if (!c) throw new Error(`退役案不存在：${case_id}`);
    return c;
  }

  #requireFrozenAffected(c, exhibit_id) {
    if (!c.frozen) throw new Error("尚未冻结部署范围");
    const snap = c.frozen.deployments.find((d) => d.exhibit_id === exhibit_id);
    if (!snap) throw new Error(`展项 ${exhibit_id} 不在冻结范围内`);
    if (!snap.affected) throw new Error(`展项 ${exhibit_id} 未命中被退役版本`);
  }
}

export function hashContent(content) {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
