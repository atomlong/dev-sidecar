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
  subscriptionSyncLowWatermark: 0, // 阶段2：有效缓存数达到该阈值时跳过远端订阅抓取；0 表示始终抓取
  cacheRefreshEnabled: true, // 阶段3：是否启用周期性缓存探测与回填
  cacheRefreshInterval: 21600, // 阶段3：周期性重检缓存文件的间隔（秒），默认 6 小时
  cacheBatchTimeout: 120, // 阶段3：每批 burst 探测等待上限（秒），配合 batchSize=128
  cacheRefreshBatchSize: 128, // 阶段3：固定每批探测节点数；增大批次能提升探测吞吐，缩短缓存全覆盖时间
  cacheRefreshProbeSamples: 2, // 阶段3：每批 burst 探测样本数
  subscriptionStaleAfterDays: 30, // 订阅连续无可用节点且无节点引用后的数据库清理阈值（天）
  subscriptions: [], // 订阅地址列表
  nodes: [], // 手动节点列表
  rules: [], // 路由规则 [{domain: 'openai.com', outboundTag: 'proxy'}]
  probeUrl: 'https://www.google.com/generate_204',
  probeInterval: 300,
}
