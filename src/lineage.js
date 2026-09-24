/**
 * 组件谱系追溯：只读模型，完全由事件流重建（服务重启后结论一致）。
 *
 * 管理者从任一上线版本（release_id）出发，可以追溯：
 * - 版本谱系（parent_release_id 链）；
 * - 该版本在各展项、各渠道的部署；
 * - 相关学术来源撤回等证据变化；
 * - 每个退役批次中该部署的冻结项、替代方案、学术/法务签署、决定与实际执行回执；
 * - 围绕回执产生的调查项及其结论。
 */
export function traceFromRelease(events, releaseId) {
  const releases = new Map();
  const deployments = [];
  /** 撤回事件 event_id -> 撤回记录（退役通过 source_event_id 引用） */
  const withdrawalEvents = new Map();
  /** key: retirement_id|item_id */
  const itemIndex = new Map();
  const retirements = new Map();
  /** replacement_release_id -> 由哪些退役替换决定引入（同一新版本可用于多个展项） */
  const incomingReplacements = new Map();

  const ensureItem = (retirementId, itemId) => {
    if (!itemIndex.has(`${retirementId}|${itemId}`)) {
      itemIndex.set(`${retirementId}|${itemId}`, {
        retirement_id: retirementId,
        item_id: itemId,
        exhibit_id: null,
        release_id: null,
        channel: null,
        frozen_at: null,
        plans: [],
        signatures: [],
        decision: null,
        receipts: [],
        conflicts: [],
      });
    }
    return itemIndex.get(`${retirementId}|${itemId}`);
  };

  for (const event of events) {
    const p = event.payload ?? {};
    switch (event.event_type) {
      case "COMPONENT_RELEASED":
        releases.set(p.release_id, { ...p, released_at: event.occurred_at });
        break;
      case "COMPONENT_DEPLOYED":
        deployments.push({ ...p, deployed_event_seq: event.seq });
        break;
      case "SOURCE_WITHDRAWN":
        withdrawalEvents.set(event.event_id, { ...p, withdrawn_at: event.occurred_at, event_id: event.event_id });
        break;
      case "RETIREMENT_INITIATED":
        retirements.set(p.retirement_id, {
          retirement_id: p.retirement_id,
          component_id: p.component_id,
          component_version: p.component_version,
          reason_code: p.reason_code,
          reason_detail: p.reason_detail,
          initiated_at: event.occurred_at,
          source_event_id: p.source_event_id ?? null,
          excluded: [],
          emergency_blocks: [],
          batch_closures: [],
        });
        break;
      case "DEPLOYMENT_SCOPE_FROZEN": {
        const r = retirements.get(p.retirement_id);
        r.excluded = p.excluded.map((x) => ({ ...x }));
        for (const item of p.items) {
          const node = ensureItem(p.retirement_id, item.item_id);
          Object.assign(node, {
            exhibit_id: item.exhibit_id,
            release_id: item.release_id,
            channel: item.channel,
            frozen_at: event.occurred_at,
          });
        }
        break;
      }
      case "EMERGENCY_BLOCK_ISSUED":
        retirements.get(p.retirement_id).emergency_blocks.push({
          at: event.occurred_at,
          reason_code: p.reason_code,
          reason_detail: p.reason_detail,
          hits: p.hits.map((h) => ({ ...h })),
        });
        break;
      case "REPLACEMENT_PLAN_SUBMITTED":
        ensureItem(p.retirement_id, p.item_id).plans.push({
          at: event.occurred_at,
          plan_kind: p.plan_kind,
          replacement_release_id: p.replacement_release_id ?? null,
          note: p.note,
          submitted_by: p.submitted_by,
        });
        break;
      case "RETIREMENT_SIGNED":
        ensureItem(p.retirement_id, p.item_id).signatures.push({
          at: event.occurred_at,
          role: p.role,
          signer: p.signer,
        });
        break;
      case "RETIREMENT_ITEM_DECIDED": {
        const node = ensureItem(p.retirement_id, p.item_id);
        node.decision = {
          at: event.occurred_at,
          decision: p.decision,
          detail: p.detail,
          replacement_release_id: p.replacement_release_id ?? null,
          academic_signer: p.academic_signer,
          legal_signer: p.legal_signer,
        };
        if (p.decision === "REPLACE" && p.replacement_release_id) {
          const list = incomingReplacements.get(p.replacement_release_id) ?? [];
          list.push({
            at: event.occurred_at,
            retirement_id: p.retirement_id,
            item_id: p.item_id,
            exhibit_id: p.exhibit_id,
            superseded_release_id: node.release_id,
          });
          incomingReplacements.set(p.replacement_release_id, list);
        }
        break;
      }
      case "EXECUTION_RECEIPT_RECORDED":
        ensureItem(p.retirement_id, p.item_id).receipts.push({
          at: event.occurred_at,
          receipt_no: p.receipt_no,
          channel: p.channel,
          action: p.action,
          content_hash: p.content_hash,
          event_id: event.event_id,
        });
        break;
      case "RECEIPT_CONFLICT_FLAGGED": {
        ensureItem(p.retirement_id, p.item_id).conflicts.push({
          at: event.occurred_at,
          investigation_id: p.investigation_id,
          receipt_no: p.receipt_no,
          received_content_hash: p.received_content_hash,
          recorded_content_hash: p.recorded_content_hash,
          recorded_retirement_id: p.recorded_retirement_id,
          recorded_item_id: p.recorded_item_id,
          resolution: null,
        });
        break;
      }
      case "INVESTIGATION_RESOLVED": {
        for (const node of itemIndex.values()) {
          for (const conflict of node.conflicts) {
            if (conflict.investigation_id === p.investigation_id) {
              conflict.resolution = { resolution: p.resolution, note: p.note, at: event.occurred_at };
            }
          }
        }
        break;
      }
      case "RETIREMENT_BATCH_CLOSED":
        retirements.get(p.retirement_id).batch_closures.push({
          at: event.occurred_at,
          completed: p.completed.slice(),
          outstanding: p.outstanding.map((o) => ({ ...o })),
        });
        break;
      default:
        break;
    }
  }

  // 沿 parent_release_id 回溯版本谱系。
  const chain = [];
  let cursor = releaseId;
  const guard = new Set();
  while (cursor && releases.has(cursor) && !guard.has(cursor)) {
    guard.add(cursor);
    const rel = releases.get(cursor);
    chain.push({
      release_id: rel.release_id,
      component_id: rel.component_id,
      version: rel.version,
      parent_release_id: rel.parent_release_id,
      released_at: rel.released_at,
    });
    cursor = rel.parent_release_id;
  }
  if (cursor && !releases.has(cursor)) {
    chain.push({ release_id: cursor, unknown: true });
  }

  // 该版本的部署与各部署经历的退役处置。
  const deployedOn = deployments
    .filter((d) => d.release_id === releaseId)
    .map((d) => {
      const retirementTrail = [...itemIndex.values()]
        .filter((i) => i.release_id === releaseId && i.exhibit_id === d.exhibit_id && i.channel === d.channel)
        .map((node) => {
          const r = retirements.get(node.retirement_id);
          const evidence = r.source_event_id ? withdrawalEvents.get(r.source_event_id) ?? null : null;
          return {
            retirement_id: node.retirement_id,
            item_id: node.item_id,
            frozen_at: node.frozen_at,
            reason_code: r.reason_code,
            source_event_id: r.source_event_id,
            evidence_withdrawal: evidence,
            emergency_blocks: r.emergency_blocks.filter((b) =>
              b.hits.some(
                (h) =>
                  h.exhibit_id === node.exhibit_id &&
                  h.release_id === node.release_id &&
                  h.channel === node.channel,
              ),
            ),
            plans: node.plans,
            signatures: node.signatures,
            decision: node.decision,
            receipts: node.receipts,
            conflicts: node.conflicts,
          };
        });
      return {
        exhibit_id: d.exhibit_id,
        channel: d.channel,
        deployed_at: d.deployed_at,
        // 该部署在相邻批次中因前批未确认动作被排除的记录。
        excluded_from: [...retirements.values()]
          .flatMap((r) =>
            r.excluded
              .filter(
                (x) =>
                  x.release_id === releaseId &&
                  x.exhibit_id === d.exhibit_id &&
                  x.channel === d.channel,
              )
              .map((x) => ({
                retirement_id: r.retirement_id,
                reason_code: x.reason_code,
                blocking_retirement_id: x.blocking_retirement_id,
              })),
          ),
        retirement_trail: retirementTrail,
      };
    });

  return {
    release_id: releaseId,
    lineage: chain,
    // 本版本作为“替换方案”被哪些退役决定引入（从新版本反向看到上一批处置）。
    introduced_by_replacements: incomingReplacements.get(releaseId) ?? [],
    deployed_on: deployedOn,
  };
}
