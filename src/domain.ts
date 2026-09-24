/** 数字文化展项立项台使用的领域事件信封。记录一经接收不得原地改写，更正使用新的后继记录。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  /** 同一聚合内严格递增，从 1 开始。 */
  version: number;
  summary: string;
  /** 事件负载；不同事件类型各自约定字段，信封本身不限制。 */
  payload?: Record<string, unknown>;
  /** 因果关联，例如处置动作编号、批次编号、回执编号、调查项编号。 */
  causation_id?: string;
  /** 相关聚合编号，例如处置动作所属退役案。 */
  correlation_id?: string;
}

export type DomainEventType =
  | "THESIS_SUBMITTED"
  | "SOURCE_CLEARED"
  | "SOURCE_WITHDRAWN"
  | "COMPONENT_REUSE_REGISTERED"
  | "SIMILARITY_FLAGGED"
  | "CHANGE_REVIEWED"
  | "VERSION_RELEASED"
  | "COMPONENT_BLOCKED_URGENTLY"
  | "RETIREMENT_INITIATED"
  | "DEPLOYMENT_SCOPE_FROZEN"
  | "REPLACEMENT_SUBMITTED"
  | "SIGNED_OFF_BY_ACADEMIC"
  | "SIGNED_OFF_BY_LEGAL"
  | "DISPOSAL_DECIDED"
  | "DISPOSAL_REQUESTED"
  | "DISPOSAL_BATCH_CLOSED"
  | "EXECUTION_RECEIPT_REPORTED"
  | "EXECUTION_RECEIPT_CONFIRMED"
  | "RECEIPT_DISCREPANCY_INVESTIGATION_OPENED"
  | "INVESTIGATION_RESOLVED";

export type AggregateType =
  | "curatorial_thesis"
  | "research_asset"
  | "experience_proposal"
  | "approval_decision"
  | "component_version"
  | "retirement_case"
  | "disposal_action"
  | "execution_receipt"
  | "receipt_investigation"
  | "urgent_block";

/** 处置方式：立即暂停 / 更换素材或组件 / 授权范围不受影响，补充说明后继续运行。 */
export type DisposalKind = "pause" | "replace" | "annotate";

/** 处置动作的生命周期状态。 */
export type DisposalStatus =
  | "decided"
  | "requested"
  | "receipt_reported"
  | "receipt_confirmed"
  | "under_investigation"
  | "investigated_confirmed";

/** 单个展项在某次退役冻结时刻的部署快照条目。一个展项可同时在役多个互动组件。 */
export interface FrozenDeployment {
  exhibit_id: string;
  exhibit_name: string;
  channel_id: string | null;
  proposal_id: string | null;
  /** 冻结时该展项在役的全部组件版本，形如 component@version。 */
  in_service_components: string[];
  /** 命中被退役版本时为 component@version，否则为 null。 */
  deployed_component_version: string | null;
  /** 该展项是否命中被退役版本。 */
  affected: boolean;
  frozen_at: string;
}

/** 渠道回执上报结果。 */
export type ReceiptOutcome =
  | "reported"
  | "ignored_duplicate"
  | "investigation_opened";
