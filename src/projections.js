/**
 * 从仅追加事件流折叠出的读模型。
 *
 * 三类视图：
 * 1. 复用与来源登记：策展命题下的组件复用记录、组件版本谱系、学术来源撤回。
 * 2. 退役视图：退役案、每展项处置动作、批次、渠道回执、回执调查项、紧急阻断。
 * 3. 谱系追溯：从任一上线版本追到组件谱系、证据变化、签署决定与实际执行。
 *
 * 服务重启时用全部历史事件重放即可重建，进度不丢；任何视图都只是事件的派生结果，
 * 从不回写历史事件。
 */

const CONFIRMED_STATUSES = new Set(["receipt_confirmed", "investigated_confirmed"]);
export class Projections {
  constructor() {
    // 一个数字展项可同时复用多个互动组件：deployments 为在役组件集合，history 为全部登记。
    this.exhibits = new Map(); // exhibit_id -> { exhibit_name, deployments: Map(key, record), history: [] }
    this.sourcesWithdrawn = new Map(); // source_id -> 撤回事件
    this.componentReleases = new Map(); // component_id -> [版本发布记录]
    this.blocks = new Map(); // `${component_id}@${version}` -> 阻断事件

    this.cases = new Map(); // case_id -> 案状态
    this.actions = new Map(); // action_id -> 动作状态
    this.receipts = new Map(); // receipt_no -> 回执状态
    this.investigations = new Map(); // investigation_id -> 调查项状态
  }

  apply(event) {
    switch (event.event_type) {
      case "COMPONENT_REUSE_REGISTERED":
        this.#applyReuse(event);
        break;
      case "VERSION_RELEASED":
        this.#applyComponentRelease(event);
        break;
      case "SOURCE_WITHDRAWN":
        this.sourcesWithdrawn.set(event.aggregate_id, event);
        break;
      case "COMPONENT_BLOCKED_URGENTLY": {
        const p = event.payload;
        this.blocks.set(`${p.component_id}@${p.component_version}`, event);
        break;
      }
      case "RETIREMENT_INITIATED":
        this.#applyInitiated(event);
        break;
      case "DEPLOYMENT_SCOPE_FROZEN":
        this.#applyFrozen(event);
        break;
      case "REPLACEMENT_SUBMITTED":
        this.#applyReplacement(event);
        break;
      case "SIGNED_OFF_BY_ACADEMIC":
      case "SIGNED_OFF_BY_LEGAL":
        this.#applySignoff(event);
        break;
      case "DISPOSAL_DECIDED":
        this.#applyDecided(event);
        break;
      case "DISPOSAL_REQUESTED":
        this.#applyRequested(event);
        break;
      case "DISPOSAL_BATCH_CLOSED":
        this.#applyBatchClosed(event);
        break;
      case "EXECUTION_RECEIPT_REPORTED":
        this.#applyReceiptReport(event);
        break;
      case "EXECUTION_RECEIPT_CONFIRMED":
        this.#applyReceiptConfirmed(event);
        break;
      case "RECEIPT_DISCREPANCY_INVESTIGATION_OPENED":
        this.#applyInvestigationOpened(event);
        break;
      case "INVESTIGATION_RESOLVED":
        this.#applyInvestigationResolved(event);
        break;
      default:
        // 立项台既有事件与退役视图无关。
        break;
    }
  }

  #applyReuse(event) {
    const p = event.payload;
    const exhibitId = p.exhibit_id ?? event.aggregate_id;
    const record = { ...p, exhibit_id: exhibitId, recorded_event: event.event_id, recorded_at: event.occurred_at };
    const entry = this.exhibits.get(exhibitId) ?? { exhibit_name: p.exhibit_name, deployments: new Map(), history: [] };
    entry.exhibit_name = p.exhibit_name ?? entry.exhibit_name;
    entry.history.push(record);
    // 同一组件升级版本会覆盖其旧在役条目；不同组件并存，支撑“一展项含多个互动组件”。
    entry.deployments.set(p.component_id, record);
    this.exhibits.set(exhibitId, entry);
  }

  #applyComponentRelease(event) {
    const p = event.payload;
    const list = this.componentReleases.get(p.component_id) ?? [];
    list.push({ ...p, released_event: event.event_id, released_at: event.occurred_at });
    this.componentReleases.set(p.component_id, list);
  }

  #applyInitiated(event) {
    const p = event.payload;
    this.cases.set(event.aggregate_id, {
      case_id: event.aggregate_id,
      component_id: p.component_id,
      component_version: p.component_version,
      reason: p.reason,
      reason_source_id: p.reason_source_id,
      initiator: p.initiator,
      related_blocks: p.related_blocks ?? [],
      opened_at: event.occurred_at,
      opened_event: event.event_id,
      frozen: null,
      excluded: [],
      replacements: new Map(),
      academic_signoffs: [],
      legal_signoffs: [],
      decisions: [],
      batches: new Map(),
    });
  }

  #applyFrozen(event) {
    const c = this.cases.get(event.aggregate_id);
    const p = event.payload;
    c.frozen = { frozen_at: p.frozen_at, deployments: p.deployments };
    c.excluded = p.excluded ?? [];
  }

  #applyReplacement(event) {
    const c = this.cases.get(event.aggregate_id);
    const p = event.payload;
    const list = c.replacements.get(p.exhibit_id) ?? [];
    list.push({ ...p, at: event.occurred_at, event_id: event.event_id });
    c.replacements.set(p.exhibit_id, list);
  }

  #applySignoff(event) {
    const c = this.cases.get(event.aggregate_id);
    const record = { signer: event.payload.signer, note: event.payload.note, at: event.occurred_at, event_id: event.event_id };
    if (event.event_type === "SIGNED_OFF_BY_ACADEMIC") c.academic_signoffs.push(record);
    else c.legal_signoffs.push(record);
  }

  #applyDecided(event) {
    const c = this.cases.get(event.aggregate_id);
    for (const d of event.payload.decisions) {
      c.decisions.push(d);
      this.actions.set(d.action_id, {
        action_id: d.action_id,
        case_id: c.case_id,
        exhibit_id: d.exhibit_id,
        channel_id: d.channel_id,
        kind: d.kind,
        note: d.note,
        replacement_ref: d.replacement_ref,
        status: "decided",
        request: null,
        receipt_no: null,
        investigation_id: null,
      });
    }
  }

  #applyRequested(event) {
    const a = this.actions.get(event.aggregate_id);
    const p = event.payload;
    a.status = "requested";
    a.request = { batch_id: p.batch_id, at: event.occurred_at, event_id: event.event_id, note: p.note };
    const c = this.cases.get(p.case_id);
    if (!c.batches.has(p.batch_id)) c.batches.set(p.batch_id, { batch_id: p.batch_id, requested: [], closed: null });
    c.batches.get(p.batch_id).requested.push(a.action_id);
  }

  #applyBatchClosed(event) {
    const c = this.cases.get(event.aggregate_id);
    const b = c.batches.get(event.payload.batch_id);
    b.closed = { at: event.occurred_at, summary: event.payload.summary, event_id: event.event_id };
  }

  #applyReceiptReport(event) {
    const p = event.payload;
    const report = {
      seq: p.report_seq ?? event.version,
      channel_id: p.channel_id,
      content: p.content,
      content_hash: p.content_hash,
      at: event.occurred_at,
      event_id: event.event_id,
    };
    let receipt = this.receipts.get(p.receipt_no);
    if (!receipt) {
      receipt = {
        receipt_no: p.receipt_no,
        case_id: p.case_id,
        action_id: p.action_id,
        exhibit_id: p.exhibit_id,
        reports: [],
        investigation_id: null,
        confirmed_event: null,
      };
      this.receipts.set(p.receipt_no, receipt);
    }
    receipt.reports.push(report);

    // 首报只代表渠道已上报，进入“待核”，是否成功由确认/调查结论决定；
    // 重复送达与异议报告不改变动作状态（异议另有调查事件驱动）。
    const action = this.actions.get(p.action_id);
    if (action && action.status === "requested") {
      action.status = "receipt_reported";
      action.receipt_no = p.receipt_no;
    }
  }

  #applyReceiptConfirmed(event) {
    const p = event.payload;
    const receipt = this.receipts.get(p.receipt_no);
    if (receipt) receipt.confirmed_event = event.event_id;
    const action = this.actions.get(p.action_id);
    // 平台核验确认；未结调查期间不得直接确认。
    if (action && action.status !== "under_investigation" && !CONFIRMED_STATUSES.has(action.status)) {
      action.status = "receipt_confirmed";
      action.receipt_no = p.receipt_no;
      action.confirmed_by = p.confirmed_by ?? null;
      action.confirmed_at = event.occurred_at;
    }
  }

  #applyInvestigationOpened(event) {
    const p = event.payload;
    const receipt = this.receipts.get(p.receipt_no);
    const action = receipt ? this.actions.get(receipt.action_id) : null;
    this.investigations.set(event.aggregate_id, {
      investigation_id: event.aggregate_id,
      receipt_no: p.receipt_no,
      status: "open",
      reason: p.reason,
      opened_at: event.occurred_at,
      reports: p.reports,
      // 异议若在动作确认后才出现，调查只挂账，不回退其确认状态。
      action_status_at_open: action ? action.status : null,
      resolution: null,
    });
    if (receipt) receipt.investigation_id = event.aggregate_id;
    if (action && !CONFIRMED_STATUSES.has(action.status)) {
      action.status = "under_investigation";
      action.investigation_id = event.aggregate_id;
    }
  }

  #applyInvestigationResolved(event) {
    const inv = this.investigations.get(event.aggregate_id);
    const p = event.payload;
    inv.status = "resolved";
    inv.resolution = { ...p, at: event.occurred_at };
    const receipt = this.receipts.get(inv.receipt_no);
    const action = this.actions.get(receipt.action_id);
    if (CONFIRMED_STATUSES.has(inv.action_status_at_open)) {
      // 确认后出现的异议如何处理由后继事件决定，调查结论本身不回退既有确认。
      return;
    }
    if (p.confirmed) {
      action.status = "investigated_confirmed";
    } else {
      // 异议成立、原执行不成立：退回待重报；调查编号作为历史关联保留。
      action.status = "requested";
    }
  }

  // ---- 查询 ----

  getCase(caseId) {
    return this.cases.get(caseId);
  }

  getAction(actionId) {
    return this.actions.get(actionId);
  }

  /** 该展项是否存在任何退役案中尚未确认的处置动作（含调查未结）。 */
  pendingActionsForExhibit(exhibitId) {
    return [...this.actions.values()].filter(
      (a) => a.exhibit_id === exhibitId && !CONFIRMED_STATUSES.has(a.status),
    );
  }

  isActionConfirmed(action) {
    return CONFIRMED_STATUSES.has(action.status);
  }

  isBlocked(componentId, version) {
    return this.blocks.has(`${componentId}@${version}`);
  }

  /** 展项当前在役内容中命中任一紧急阻断的组件。 */
  currentlyBlockedExhibits() {
    const hit = [];
    for (const [exhibitId, entry] of this.exhibits) {
      for (const cur of entry.deployments.values()) {
        if (this.blocks.has(`${cur.component_id}@${cur.component_version}`)) {
          hit.push({ exhibit_id: exhibitId, component_id: cur.component_id, component_version: cur.component_version });
        }
      }
    }
    return hit;
  }

  /**
   * 从任一上线版本（或组件版本）追溯：组件谱系、证据变化、签署决定、实际执行。
   * 入参：{ component_id, component_version } 或 { exhibit_id, online_release }。
   */
  trace(query) {
    let componentId = query.component_id;
    let componentVersion = query.component_version;
    let locatedBy = null;
    if (componentId === undefined) {
      const found = this.#findDeployment(query.exhibit_id, query.online_release);
      if (!found) return null;
      componentId = found.component_id;
      componentVersion = found.component_version;
      locatedBy = found;
    }

    const reuseAcrossExhibits = [];
    for (const [exhibitId, entry] of this.exhibits) {
      for (const rec of entry.history) {
        if (rec.component_id === componentId && rec.component_version === componentVersion) {
          reuseAcrossExhibits.push({ exhibit_id: exhibitId, ...rec });
        }
      }
    }

    const releases = (this.componentReleases.get(componentId) ?? []).filter(
      (r) => r.component_version === componentVersion,
    );

    // 证据变化：与该版本关联、且已被撤回的学术来源。
    const linkedSourceIds = new Set();
    for (const r of releases) for (const id of r.source_ids ?? []) linkedSourceIds.add(id);
    for (const rec of reuseAcrossExhibits) for (const id of rec.source_ids ?? []) linkedSourceIds.add(id);
    const evidenceChanges = [...linkedSourceIds]
      .map((id) => this.sourcesWithdrawn.get(id))
      .filter(Boolean)
      .map((event) => ({ source_id: event.aggregate_id, reason: event.payload.reason, withdrawn_at: event.occurred_at, event_id: event.event_id }));

    const relatedCases = [...this.cases.values()]
      .filter((c) => c.component_id === componentId && c.component_version === componentVersion)
      .map((c) => this.#describeCase(c));

    return {
      query,
      located_via: locatedBy,
      component: { component_id: componentId, component_version: componentVersion },
      genealogy: {
        releases,
        reuse_across_exhibits: reuseAcrossExhibits,
        frozen_snapshots: relatedCases.flatMap((c) =>
          (c.frozen_scope?.deployments ?? [])
            .filter((d) => d.deployed_component_version === `${componentId}@${componentVersion}`)
            .map((d) => ({ case_id: c.case_id, ...d })),
        ),
      },
      evidence_changes: evidenceChanges,
      retirement_cases: relatedCases,
    };
  }

  #findDeployment(exhibitId, onlineRelease) {
    const entry = this.exhibits.get(exhibitId);
    if (!entry) return null;
    if (onlineRelease === undefined) {
      // 未指定上线版本时，以该展项任一在役组件作为定位锚点（调用方一般直接给组件版本）。
      return [...entry.deployments.values()][0] ?? null;
    }
    return entry.history.find((r) => r.online_release === onlineRelease) ?? null;
  }

  describeCase(c) {
    return this.#describeCase(c);
  }

  #describeCase(c) {
    const latestReplacement = (exhibitId) => {
      const list = c.replacements.get(exhibitId) ?? [];
      return list.length ? list[list.length - 1] : null;
    };
    return {
      case_id: c.case_id,
      opened_at: c.opened_at,
      reason: c.reason,
      initiator: c.initiator,
      related_blocks: c.related_blocks,
      frozen_scope: c.frozen
        ? { frozen_at: c.frozen.frozen_at, deployments: c.frozen.deployments, excluded: c.excluded }
        : null,
      replacements: [...c.replacements.entries()].map(([exhibit_id, list]) => ({
        exhibit_id,
        submitted_count: list.length,
        latest: list[list.length - 1],
      })),
      signoffs: { academic: c.academic_signoffs, legal: c.legal_signoffs },
      decisions: c.decisions.map((d) => {
        const action = this.actions.get(d.action_id);
        const receipt = action.receipt_no ? this.receipts.get(action.receipt_no) : null;
        const investigation = action.investigation_id ? this.investigations.get(action.investigation_id) : null;
        return {
          ...d,
          replacement: latestReplacement(d.exhibit_id),
          execution: {
            status: action.status,
            request: action.request,
            receipt: receipt
              ? {
                  receipt_no: receipt.receipt_no,
                  reports: receipt.reports,
                  investigation_id: receipt.investigation_id,
                }
              : null,
            investigation: investigation
              ? { status: investigation.status, reason: investigation.reason, resolution: investigation.resolution }
              : null,
          },
        };
      }),
      batches: [...c.batches.values()],
    };
  }
}
