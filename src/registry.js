import { createHash } from "node:crypto";

/**
 * 组件谱系登记：组件、版本发布、展项部署、学术来源撤回。
 * 所有变化都以事件追加，Catalog 为重放得到的只读投影。
 */
export class RegistryService {
  /**
   * @param {import("./store.js").EventStore} store
   * @param {{ now?: () => string, newId?: (prefix: string) => string }} [options]
   */
  constructor(store, options = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? ((p) => `${p}-${Math.random().toString(16).slice(2, 10)}`);
  }

  _emit(event) {
    return this.store.append({
      occurred_at: this.now(),
      ...event,
    });
  }

  registerComponent({ component_id, name, description = "" }) {
    return this._emit({
      event_id: this.newId("evt"),
      event_type: "COMPONENT_REGISTERED",
      aggregate_type: "interactive_component",
      aggregate_id: component_id,
      version: this.store.nextVersion(component_id),
      summary: `登记互动组件 ${name}`,
      payload: { component_id, name, description },
    });
  }

  /**
   * 发布一个上线版本。parent_release_id 指向衍生来源版本，形成组件谱系。
   */
  releaseVersion({ component_id, release_id, version, parent_release_id = null, note = "" }) {
    return this._emit({
      event_id: this.newId("evt"),
      event_type: "COMPONENT_RELEASED",
      aggregate_type: "interactive_component",
      aggregate_id: component_id,
      version: this.store.nextVersion(component_id),
      summary: `组件 ${component_id} 发布版本 ${version}`,
      payload: { component_id, release_id, version, parent_release_id, note },
    });
  }

  deploy({ exhibit_id, release_id, component_id, component_version, channel, deployed_at }) {
    return this._emit({
      event_id: this.newId("evt"),
      event_type: "COMPONENT_DEPLOYED",
      aggregate_type: "digital_exhibit",
      aggregate_id: exhibit_id,
      version: this.store.nextVersion(exhibit_id),
      summary: `展项 ${exhibit_id} 在渠道 ${channel} 部署 ${release_id}`,
      payload: {
        exhibit_id,
        release_id,
        component_id,
        component_version,
        channel,
        deployed_at: deployed_at ?? this.now(),
      },
    });
  }

  /** 学术来源撤回：证据变化本身也是不可改写的事件。 */
  withdrawSource({ source_id, reason_code, reason_detail, withdrawn_by }) {
    return this._emit({
      event_id: this.newId("evt"),
      event_type: "SOURCE_WITHDRAWN",
      aggregate_type: "research_asset",
      aggregate_id: source_id,
      version: this.store.nextVersion(source_id),
      summary: `学术来源 ${source_id} 撤回：${reason_code}`,
      payload: { source_id, reason_code, reason_detail, withdrawn_by },
    });
  }
}

export function hashContent(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * 全事件流重放得到的谱系投影。
 */
export class Catalog {
  constructor() {
    this.components = new Map();
    /** release_id -> 发布记录 */
    this.releases = new Map();
    /** 部署键 exhibit_id|release_id|channel -> 部署行 */
    this.deployments = new Map();
    /** item_id -> 冻结行（用于回执落地时定位部署） */
    this.frozenItems = new Map();
    /** source_id -> 撤回事件 */
    this.sourceWithdrawals = new Map();
  }

  apply(event) {
    switch (event.event_type) {
      case "COMPONENT_REGISTERED":
        this.components.set(event.payload.component_id, {
          component_id: event.payload.component_id,
          name: event.payload.name,
        });
        break;
      case "COMPONENT_RELEASED":
        this.releases.set(event.payload.release_id, { ...event.payload });
        break;
      case "COMPONENT_DEPLOYED": {
        const key = deploymentKey(
          event.payload.exhibit_id,
          event.payload.release_id,
          event.payload.channel,
        );
        this.deployments.set(key, { ...event.payload, active: true });
        break;
      }
      case "DEPLOYMENT_SCOPE_FROZEN":
        for (const item of event.payload.items) {
          this.frozenItems.set(item.item_id, item);
        }
        break;
      case "EXECUTION_RECEIPT_RECORDED": {
        // 暂停与替换的实际执行意味着该部署已下线；补充说明不改变运行状态。
        if (event.payload.action === "PAUSE" || event.payload.action === "REPLACE") {
          const frozen = this.frozenItems.get(event.payload.item_id);
          if (frozen) {
            const key = deploymentKey(frozen.exhibit_id, frozen.release_id, frozen.channel);
            const dep = this.deployments.get(key);
            if (dep) dep.active = false;
          }
        }
        break;
      }
      case "SOURCE_WITHDRAWN":
        this.sourceWithdrawals.set(event.payload.source_id, event);
        break;
      default:
        break;
    }
    return this;
  }

  static fromEvents(events) {
    const catalog = new Catalog();
    for (const e of events) catalog.apply(e);
    return catalog;
  }

  /** 某组件精确版本在当时仍处于运行状态的部署（冻结时刻快照的数据源）。 */
  activeDeployments(componentId, componentVersion) {
    return [...this.deployments.values()].filter(
      (d) =>
        d.active &&
        d.component_id === componentId &&
        d.component_version === componentVersion,
    );
  }

  getDeployment(exhibitId, releaseId, channel) {
    return this.deployments.get(deploymentKey(exhibitId, releaseId, channel));
  }
}

export function deploymentKey(exhibitId, releaseId, channel) {
  return `${exhibitId}|${releaseId}|${channel}`;
}
