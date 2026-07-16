// Stage3 batch level → (batchSize, maxOldSpaceSizeMB, stage3GcThresholdMB) mapping.
// Each level doubles the previous batch size. The V8 old-space cap and the
// stage3 explicit-GC threshold are pinned per-level so operators cannot
// desync them by picking an arbitrary batchSize.
const STAGE3_BATCH_LEVEL_TABLE = {
  1: { batchSize: 64,   maxOldSpaceSizeMB: 48,  stage3GcThresholdMB: 32  },
  2: { batchSize: 128,  maxOldSpaceSizeMB: 80,  stage3GcThresholdMB: 56  },
  3: { batchSize: 256,  maxOldSpaceSizeMB: 128, stage3GcThresholdMB: 96  },
  4: { batchSize: 512,  maxOldSpaceSizeMB: 256, stage3GcThresholdMB: 192 },
  5: { batchSize: 1024, maxOldSpaceSizeMB: 512, stage3GcThresholdMB: 384 },
}
const STAGE3_BATCH_LEVEL_DEFAULT = 2

module.exports = {
  enabled: false,
  name: 'Xray',
  tip: 'Xray 核心插件，支持 VLESS/VMess/Trojan 等高级协议',
  localPort: 10801, // 默认端口，0表示自动
  startupNodeLimit: 10, // 阶段1：启动时最多使用多少个可用节点
  bootstrapBatchTimeout: 30, // 阶段1：启动前快速复检缓存候选节点的超时（秒）
  bootstrapCandidateLimit: 31, // 阶段1：启动前最多复检多少个缓存候选节点
  bootstrapProbeSamples: 2, // 阶段1：启动前快速复检的 burst 样本数
  allowedCountries: [], // 允许使用的国家/地区代码，例如 ['SG', '!JP']
  allowedOwners: [], // 允许使用的节点提供方关键字，例如 ['amazon', '!cloudflare']
  maxDelayMs: 0, // 启动缓存节点的最大延迟（毫秒），0 表示不限制
  startupSelectEnabled: true, // 阶段1：是否启用启动节点筛选；false 时直接复用上次的 config.json，不再探测/重写
  subscriptionSyncEnabled: true, // 阶段2：是否启用订阅抓取与缓存同步；false 时跳过本阶段，直接进入第三阶段
  subscriptionSyncLowWatermark: 0, // 阶段2：stable 节点数超过该阈值时跳过远端订阅抓取；0 表示只要有 stable 节点就跳过；负数或非数字视为无效配置，记录警告并跳过远端订阅抓取（仅处理本地节点）
  subscriptionSyncIntervalDays: 3, // 阶段2：远端订阅抓取的最小间隔（天），默认 3 天；距上次抓取不足此值时跳过远端拉取，只处理本地节点
  cacheRefreshEnabled: true, // 阶段3：是否启用周期性缓存探测与回填
  cacheRefreshInterval: 21600, // 阶段3：周期性重检缓存文件的间隔（秒），默认 6 小时，最小 10800 秒（3 小时）
  cacheBatchTimeout: 120, // 阶段3：每批 burst 探测等待上限（秒），配合 level=2
  // 阶段3：探测批次等级（1-5）。level=N 对应 batchSize=N*64（即 64/128/256/512/1024）。
  // 等级越高，单批探测节点越多，吞吐越高但内存占用越大。
  // V8 old-space 上限与 stage3 显式 GC 阈值按等级精确映射，避免用户自定义任意 batchSize 导致 GC 参数失配。
  // stage3 GC 阈值 ≈ maxOldSpace 的 70-75%，留缓冲让显式 GC 在 V8 被迫 GC 前清理。
  //   level 1 (64):  max-old-space=48MB,  stage3 GC 阈值=32MB   — 低内存设备（树莓派）
  //   level 2 (128): max-old-space=80MB,  stage3 GC 阈值=56MB   — 默认，实测稳态 heap ~15MB
  //   level 3 (256): max-old-space=128MB, stage3 GC 阈值=96MB   — 中等吞吐
  //   level 4 (512): max-old-space=256MB, stage3 GC 阈值=192MB  — 高吞吐（需 ≥512M cgroup MemoryHigh）
  //   level 5 (1024):max-old-space=512MB, stage3 GC 阈值=384MB  — 极速覆盖（需 ≥1G cgroup MemoryHigh）
  // 注意：mitmproxy 子进程与 Stage3 探测共用同一 fork 路径，maxOldSpaceSizeMB 同时作用于两者。
  // 默认 cgroup MemoryHigh=280M 下仅 level 1-3 可用，level 4/5 需放宽 cgroup 限制。
  cacheRefreshBatchLevel: 2,
  cacheRefreshProbeSamples: 2, // 阶段3：每批 burst 探测样本数
  subscriptionStaleAfterDays: 30, // 订阅连续无可用节点且无节点引用后的数据库清理阈值（天）
  subscriptions: [], // 订阅地址列表
  nodes: [], // 手动节点列表
  rules: [], // 路由规则 [{domain: 'openai.com', outboundTag: 'proxy'}]
  probeUrl: 'https://www.google.com/generate_204',
  probeInterval: 300,

  // Exported so server/index.js and xray/index.js can look up the per-level
  // V8 old-space cap and stage3 GC threshold. Keep STAGE3_MAX_OLD_SPACE_BY_LEVEL
  // in server/index.js in sync with this table.
  STAGE3_BATCH_LEVEL_TABLE,
  STAGE3_BATCH_LEVEL_DEFAULT,
}
