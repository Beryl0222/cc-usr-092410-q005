/** 数字文化展项立项台使用的领域事件信封。 */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  /** 聚合内版本号，同一聚合流严格递增。 */
  version: number;
  /** 存储层分配的全局单调序号（重放后保持不变）。 */
  seq?: number;
  summary: string;
  payload: TPayload;
  causation_id?: string;
  correlation_id?: string;
}

export type DomainEventType =
  // 既有：策展命题与学术来源
  | "THESIS_SUBMITTED"
  | "SOURCE_CLEARED"
  | "SIMILARITY_FLAGGED"
  | "CHANGE_REVIEWED"
  | "VERSION_RELEASED"
  // 学术来源撤回（证据变化）
  | "SOURCE_WITHDRAWN"
  // 组件谱系与复用
  | "COMPONENT_REGISTERED"
  | "COMPONENT_RELEASED"
  | "COMPONENT_DEPLOYED"
  // 组件退役
  | "RETIREMENT_INITIATED"
  | "DEPLOYMENT_SCOPE_FROZEN"
  | "EMERGENCY_BLOCK_ISSUED"
  | "REPLACEMENT_PLAN_SUBMITTED"
  | "RETIREMENT_SIGNED"
  | "RETIREMENT_ITEM_DECIDED"
  | "EXECUTION_RECEIPT_RECORDED"
  | "RECEIPT_CONFLICT_FLAGGED"
  | "INVESTIGATION_RESOLVED"
  | "RETIREMENT_BATCH_CLOSED";

export type AggregateType =
  | "curatorial_thesis"
  | "research_asset"
  | "experience_proposal"
  | "interactive_component"
  | "digital_exhibit"
  | "component_retirement"
  | "approval_decision";

export type SignerRole = "ACADEMIC" | "LEGAL";

/** 每个展项的处置形态：暂停 / 替换素材或组件 / 授权不受影响、补充说明后继续。 */
export type ItemDecision = "PAUSE" | "REPLACE" | "ADDENDUM";

export type RetirementItemStatus =
  | "FROZEN"
  | "BLOCKED"
  | "PLAN_SUBMITTED"
  | "DECIDED"
  | "CONFLICT"
  | "COMPLETED";

export interface RetirementItemSnapshot {
  item_id: string;
  exhibit_id: string;
  release_id: string;
  component_version: string;
  channel: string;
  deployed_at: string;
}

export interface RetirementInitiatedPayload {
  retirement_id: string;
  component_id: string;
  component_version: string;
  reason_code: string;
  reason_detail: string;
  source_event_id?: string;
  initiator: string;
}

export interface DeploymentScopeFrozenPayload {
  retirement_id: string;
  component_id: string;
  component_version: string;
  items: RetirementItemSnapshot[];
  excluded: Array<{
    exhibit_id: string;
    release_id: string;
    component_version: string;
    channel: string;
    reason_code: "PRIOR_UNCONFIRMED_ACTION";
    blocking_retirement_id: string;
  }>;
}

export interface EmergencyBlockIssuedPayload {
  retirement_id: string;
  component_id: string;
  component_version: string;
  reason_code: string;
  reason_detail: string;
  hits: Array<{ exhibit_id: string; release_id: string; channel: string }>;
}

export interface ReplacementPlanPayload {
  retirement_id: string;
  item_id: string;
  exhibit_id: string;
  plan_kind: ItemDecision;
  replacement_release_id?: string;
  note: string;
  submitted_by: string;
}

export interface RetirementSignedPayload {
  retirement_id: string;
  item_id: string;
  exhibit_id: string;
  role: SignerRole;
  signer: string;
  note?: string;
}

export interface RetirementItemDecidedPayload {
  retirement_id: string;
  item_id: string;
  exhibit_id: string;
  decision: ItemDecision;
  detail: string;
  replacement_release_id?: string;
  academic_signer: string;
  legal_signer: string;
}

export interface ExecutionReceiptPayload {
  retirement_id: string;
  item_id: string;
  exhibit_id: string;
  receipt_no: string;
  channel: string;
  action: string;
  content_hash: string;
}

export interface ReceiptConflictPayload {
  investigation_id: string;
  retirement_id: string;
  item_id: string;
  exhibit_id: string;
  receipt_no: string;
  channel: string;
  received_content_hash: string;
  recorded_content_hash: string;
  recorded_retirement_id: string;
  recorded_item_id: string;
}

export interface InvestigationResolvedPayload {
  investigation_id: string;
  retirement_id: string;
  item_id: string;
  resolution: "CANONICAL_RECEIPT" | "REPORT_DISCARDED";
  note: string;
}

export interface RetirementBatchClosedPayload {
  retirement_id: string;
  completed: string[];
  outstanding: Array<{ item_id: string; exhibit_id: string; status: RetirementItemStatus }>;
}

export type RetirementEvent =
  | DomainEvent<RetirementInitiatedPayload>
  | DomainEvent<DeploymentScopeFrozenPayload>
  | DomainEvent<EmergencyBlockIssuedPayload>
  | DomainEvent<ReplacementPlanPayload>
  | DomainEvent<RetirementSignedPayload>
  | DomainEvent<RetirementItemDecidedPayload>
  | DomainEvent<ExecutionReceiptPayload>
  | DomainEvent<ReceiptConflictPayload>
  | DomainEvent<InvestigationResolvedPayload>
  | DomainEvent<RetirementBatchClosedPayload>;
