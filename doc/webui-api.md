# DevSidecar WebUI API

> Base URL: `http://127.0.0.1:31182`
>
> 所有接口返回 JSON。非 2xx 响应体含 `{ error: true, code, message }`。
>
> 写操作（POST/PUT/DELETE）默认需要本地校验；读操作（GET）公开。未来如启用 token 认证，所有 `/api/*` 需带 `Authorization: Bearer <token>`，`/api/version` 和 `/api/health` 例外。

## 通用

### GET /api/health

轻量健康检查，无副作用。用于服务重启后轮询恢复。

**响应** `200`
```json
{ "ok": true, "uptime": 12345, "pid": 67890 }
```

### GET /api/version

返回 dev-sidecar、Xray core、Node.js 版本。Xray core 版本通过 `xray version` 命令获取并缓存（进程生命周期内只执行一次）。

**响应** `200`
```json
{
  "version": "2.2.8",
  "nodeVersion": "v24.18.0",
  "xrayCoreVersion": "26.3.27"
}
```

### GET /api/status

返回当前合并后的完整运行配置（defaults + remote shared + remote personal + user overrides）。

**响应** `200` — 配置对象，结构见 `packages/core/src/config/index.js`。

### GET /api/info

返回进程信息。

**响应** `200`
```json
{
  "pid": 67890,
  "uptime": 12345,
  "version": "2.2.8",
  "nodeVersion": "v24.18.0",
  "logDir": "/home/user/.dev-sidecar/logs"
}
```

### GET /api/system

返回系统资源占用（cgroup 内存 + Node.js heap）。

**响应** `200`
```json
{
  "memory": { "rss": 65000000, "heapUsed": 11000000, "heapTotal": 30000000 },
  "cgroup": { "current": 65000000, "high": 293600000, "peak": 152000000 }
}
```

### GET /api/logs?file=core&lines=200

读取日志文件末尾 N 行。

**查询参数**
| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `file` | string | `core` | 日志文件名，可选 `core`/`server`/`gui` |
| `lines` | number | `200` | 读取行数 |

**响应** `200`
```json
{ "lines": ["[2026-08-23T11:00:48.123] [INFO] core - Xray 启动", "..."] }
```

**错误** `400` — `INVALID_FILE`（文件名非法或路径穿越）

## 代理

### POST /api/proxy/enable

开启系统代理（gsettings/env var）。

**响应** `200` `{ "status": "ok" }`

### POST /api/proxy/disable

关闭系统代理。

**响应** `200` `{ "status": "ok" }`

## 配置

### GET /api/config

返回完整运行配置（同 `/api/status`）。

### PUT /api/config

整体替换用户配置（`~/.dev-sidecar/config.json`）。合并策略用 `lodash.mergeWith` + 数组整体替换 customizer。

**请求体** — 配置对象

**响应** `200` `{ "status": "ok" }`

### PUT /api/intercepts

更新拦截规则（`server.intercepts`）。

**请求体**
```json
{ "github.com": { ".*": { "proxy": "tunnel://127.0.0.1:10801", "desc": "..." } } }
```

**响应** `200` `{ "status": "ok" }` — 保存并热重载

### PUT /api/presetiplist

更新预设 IP 列表（`server.presetIpList`）。

**请求体** — 预设 IP 数组

**响应** `200` `{ "status": "ok" }`

### PUT /api/xray/rules

更新 Xray 路由规则（`plugin.xray.rules`）。数组整体替换（非索引合并）。

**请求体**
```json
[{ "type": "field", "domain": ["chatgpt.com"], "outboundTag": "proxy" }]
```

**响应** `200` `{ "status": "ok" }` — 保存并热重载

### POST /api/config/reload

重新下载远程共享 + 个人配置并合并。

**响应** `200` `{ "status": "ok" }`

## Xray 节点

### GET /api/xray/nodes

返回 live xray 进程的 outbound 列表，并关联缓存数据库中的 country/exitIp/owner。

**响应** `200`
```json
{
  "nodes": [
    {
      "tag": "proxy_0",
      "proxySettings": { "_TypedMessage_": "xray.proxy.trojan.", "server": { "address": "172.67.149.60", "port": 443 } },
      "senderSettings": { "streamSettings": { "protocolName": "websocket", "securitySettings": [{ "serverName": "www.ignitelimit.com" }] } }
    }
  ],
  "xrayEnabled": true,
  "nodeMetadata": {
    "proxy_0": { "country": "FR", "exitIp": "51.15.243.182", "owner": "ovh" }
  }
}
```

**说明** — `nodeMetadata` 通过 `getLiveNodeFingerprints()` 拿 `tag→fingerprint` 反向映射，再用 `readCacheEntriesByFingerprints` 查缓存得到。observatory 探测状态需单独调 `/api/xray/metrics`。

**错误** `503` — `XRAY_NOT_READY`（xray 未启动或 API 端口未就绪）

### GET /api/xray/balancer

返回 balancer 当前选中节点 + sticky 锁定状态。

**响应** `200`
```json
{
  "balancer": "  - Selecting Override:\n    1   proxy_0\n  - Selects:\n    1   proxy_0",
  "xrayEnabled": true,
  "sticky": { "active": true, "tag": "proxy_0", "apiPort": 45617 }
}
```

**说明** — `balancer` 是 `xray api bi` 的原始 stdout 文本（前端解析 `Selects:\s*\d+\s+(\S+)`）。`sticky` 来自插件内部状态（比解析文本可靠）。

### POST /api/xray/sticky

锁定 balancer 到当前选中节点，duration 秒后自动解锁。

**请求体**
```json
{ "duration": 300 }
```

| 值 | 含义 |
|---|---|
| `>0` | 锁定 N 秒后自动解锁 |
| `0` | 永久锁定（内部用 10 年兜底） |

**响应** `200` `{ "tag": "proxy_0", "duration": 300 }`

### DELETE /api/xray/sticky

手动解锁 balancer。会 `clearTimeout` 取消自动解锁 timer，避免重复触发。

**安全检查** — 若 observatory 无 alive 节点（启动后首次探测周期内），拒绝解锁并返回错误，避免 balancer 无节点可选。

**响应** `200` `{ "tag": "proxy_0" }`

**错误** `500` — `STICKY_FAILED`（消息含原因，如 "observatory 还在首次探测中..."）

### GET /api/xray/metrics

代理 xray metrics 端口的 `/debug/vars`（expvar），含 observatory 节点探测结果。

**响应** `200` — xray expvar 原始 JSON，关键字段：
```json
{
  "observatory": {
    "proxy_0": { "alive": true, "delay": 955, "outbound_tag": "proxy_0", "last_seen_time": 1787453821, "last_try_time": 1787453821 }
  }
}
```

**说明** — xray 未启动时返回 `{ metrics: null, reason: "xray_not_running" }`。

## Xray 缓存

### GET /api/xray/cache/stats

返回缓存数据库统计 + 国家分布。

**响应** `200`
```json
{
  "totalNodes": 560546,
  "dbSizeBytes": 816193536,
  "countryDistribution": [{ "country": "US", "count": 12345 }, { "country": "FR", "count": 6789 }]
}
```

### GET /api/xray/cache/nodes?page=1&pageSize=50&sort=smart

分页查询缓存节点。

**查询参数**
| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `page` | number | `1` | 页码 |
| `pageSize` | number | `50` | 每页条数 |
| `sort` | string | `smart` | 排序策略，`smart` = 延时升序 + 失效置底 |

**响应** `200`
```json
{
  "rows": [
    { "country": "FR", "protocol": "trojan", "address": "172.67.149.60", "delay": 879, "stable": true }
  ],
  "total": 560546,
  "page": 1,
  "pageSize": 50
}
```

### GET /api/xray/cache/nodes/export

导出缓存节点为文件（用于备份/迁移）。触发后台导出任务，结果缓存 30s。

**响应** `200` `{ "status": "accepted" }` 或 `{ "status": "ready", "url": "/api/xray/cache/nodes/export?download=token" }`

### GET /api/xray/cache/subscriptions

返回订阅源可用性摘要。

**响应** `200`
```json
{
  "subscriptions": [
    {
      "sourceKey": "https://example.com/sub1",
      "displayLabel": "example.com",
      "retainedNodeCount": 1234,
      "availableNodeCount": 1100,
      "lastAvailableAt": "1787453821"
    }
  ]
}
```

### GET /api/xray/probed-stats

返回已探测节点统计（读取 `probed-node-stats.json`）。

**响应** `200`
```json
{
  "totalProbed": 148,
  "countryDistribution": { "FR": 45, "US": 30, "HK": 20 },
  "nodes": [
    { "protocol": "trojan", "exitIp": "51.15.243.182", "country": "FR", "owner": "ovh", "delay": 879, "stable": true }
  ]
}
```

## Xray Stage

### GET /api/xray/stage/status

返回 Stage1/2/3 的运行时状态。

**响应** `200`
```json
{
  "isStageRunning": true,
  "refreshGeneration": 5,
  "liveNodes": 20,
  "livePort": 10801,
  "apiPort": 45617,
  "metricsPort": 41135,
  "nextRefreshAt": 1787464504968,
  "stage1": {
    "processStarted": true,
    "livePort": 10801,
    "apiPort": 45617,
    "metricsPort": 41135,
    "liveNodes": 20,
    "currentSelectTag": "proxy_0"
  },
  "stage2": {
    "enabled": true,
    "state": "idle",
    "intervalHours": 24,
    "lastSyncAt": 1787456878000,
    "lastSyncDurationMs": 12000,
    "lastSyncFetchedCount": 4321,
    "nextSyncAt": 1787543278000,
    "nextSyncOverdue": false,
    "nextTriggerAt": 1787543278000,
    "startedAt": 0,
    "progress": null,
    "fetched": 4321
  },
  "stage3": {
    "enabled": true,
    "state": "running",
    "generation": 5,
    "roundStartedAt": 1787464504968,
    "nextRefreshAt": 1787468000000,
    "totalDue": 19482,
    "processed": 768,
    "batchIndex": 6,
    "plannedBatchCount": 153,
    "successBatchCount": 6,
    "availableCount": 1,
    "explicitFailureCount": 767,
    "removedCount": 767
  }
}
```

**字段说明**

| 阶段 | 字段 | 说明 |
|---|---|---|
| Stage1 | `processStarted` | 主 xray 进程是否启动（`livePort > 0`） |
| Stage1 | `currentSelectTag` | 当前 balancer 选中节点（sticky 锁定时为锁定节点） |
| Stage2 | `enabled` | 订阅同步是否开启（`subscriptionSyncEnabled`） |
| Stage2 | `state` | 三态：`off`（已关闭）/ `idle`（空闲）/ `running`（远端订阅抓取进行中） |
| Stage2 | `nextSyncAt` | 预计下次同步时间 = `lastSyncAt + intervalHours*3600*1000` |
| Stage2 | `nextSyncOverdue` | `nextSyncAt` 已过期，等待 Stage3 轮末触发 |
| Stage2 | `nextTriggerAt` | 预计触发时间 ≈ `max(nextSyncAt, 下一轮 Stage3 开始时间)`——Stage2 在 Stage3 轮末按需触发，实际触发点为满足间隔条件后的第一个 Stage3 轮结束时刻 |
| Stage2 | `startedAt` | 本轮开始时间（ms 时间戳，`state === 'running'` 时有效，否则 0） |
| Stage2 | `progress` | `{ current, total }` 当前正在抓取第几个订阅 / 订阅总数（`running` 时有效，否则 `null`） |
| Stage2 | `fetched` | 已抓取节点数：`running` 时为本轮实时累计，`idle` 时等于 `lastSyncFetchedCount` |
| Stage3 | `enabled` | 缓存周期探测是否开启（`cacheRefreshEnabled`） |
| Stage3 | `state` | 三态：`off`（已关闭）/ `idle`（空闲）/ `running`（探测轮进行中） |
| Stage3 | `roundStartedAt` | 本轮开始时间（ms 时间戳） |
| Stage3 | `nextRefreshAt` | 下一轮触发时间（ms 时间戳，本轮结束时计算） |
| Stage3 | `totalDue`/`processed` | 本轮到期候选数 / 已处理数 |
| Stage3 | `batchIndex`/`plannedBatchCount` | 当前批次 / 计划批次数 |

**说明** — Stage2 不是定时调度，在每轮 Stage3 结束时按 `subscriptionSyncIntervalHours` 判断"距上次同步是否超过间隔"决定是否触发，`nextSyncAt` 是估计值。

### GET /api/xray/stage/round-summary

返回上一轮 Stage3 的汇总（读取 `~/.dev-sidecar/xray/stage3-last-round.json`）。

**响应** `200`
```json
{
  "status": "completed",
  "startedAt": "2026-08-23 11:00:48",
  "endedAt": "2026-08-23 11:10:32",
  "durationMs": 584000,
  "candidateCount": 768,
  "dueCandidateCount": 19482,
  "batchSize": 128,
  "plannedBatchCount": 153,
  "processedBatchCount": 153,
  "successBatchCount": 150,
  "failedBatchCount": 3,
  "availableNodeCount": 245,
  "roundAvailableNodeCount": 245
}
```

### POST /api/xray/cache/refresh

手动触发 Stage3 缓存探测。

**响应** `200`
```json
{ "status": "accepted" }
```

| `status` 值 | 含义 |
|---|---|
| `accepted` | 已触发新一轮 |
| `already_running` | 已有轮次在运行，返回当前 generation |

## 服务

### POST /api/service/restart

重启 dev-sidecar 服务。先返回 202，500ms 后调 `shutdown()` + `process.exit(1)`，依赖 systemd `Restart=on-failure` 自动拉起。

**响应** `202` `{ "status": "restarting", "message": "Service will restart in ~15s" }`

**注意** — 调用后服务约 15s 不可用，前端应显示进度遮罩并轮询 `/api/health` 直到恢复。

## 静态资源与 WebSocket

### GET /

返回 WebUI 单文件 HTML（`/opt/dev-sidecar/resources/extra/webui/index.html`）。响应头含 `Cache-Control: no-store` 避免浏览器缓存旧版。

### GET /index.html

同 `GET /`。

### WebSocket /ws

状态推送通道。连接后服务端推送 `status` 和 `error` 事件。

**客户端连接** — `ws://127.0.0.1:31182/ws`

**消息格式**
```json
{ "channel": "status", "data": { "key": "plugin.xray.enabled", "value": true } }
```

| `channel` | `data` | 说明 |
|---|---|---|
| `status` | `{ key, value }` | 状态变更（如 xray 启用/端口变化） |
| `error` | `{ key, value }` | 错误事件 |
| `speed` | — | 测速事件 |

## 错误码

| code | HTTP | 含义 |
|---|---|---|
| `INTERNAL_ERROR` | 500 | 路由异常 |
| `XRAY_NOT_READY` | 503 | xray 未启动或 API 端口未就绪 |
| `STICKY_FAILED` | 500 | sticky 锁定/解锁失败（消息含原因） |
| `INVALID_FILE` | 400 | 日志文件名非法 |
| `METHOD_NOT_AVAILABLE` | 200 | xray 插件未加载（`getStageStatus` 返回） |

## 部署与端口

| 端口 | 协议 | 用途 |
|---|---|---|
| 31180 | HTTP | mitmproxy HTTP 代理 |
| 31181 | HTTPS | mitmproxy HTTPS 代理 |
| 31182 | HTTP | WebUI + API + WebSocket |
| 10801 | HTTP | Xray 主进程出站代理（动态） |
| 动态 | HTTP | Xray gRPC API（`apiPort`，每启动变化） |
| 动态 | HTTP | Xray metrics（`metricsPort`，`/debug/vars`） |

## 相关文件

| 文件 | 说明 |
|---|---|
| `packages/core/src/modules/plugin/webui/routes.js` | 所有 HTTP 路由定义 |
| `packages/core/src/modules/plugin/webui/index.js` | http.Server + WebSocket 启动 |
| `packages/core/src/modules/plugin/webui/ws.js` | WebSocket 服务 |
| `packages/gui/extra/webui/index.html` | 前端单文件 HTML |
| `packages/core/src/modules/plugin/xray/index.js` | `getStageStatus` / `getLiveNodeFingerprints` / sticky API |
| `packages/core/src/modules/plugin/xray/cache.js` | 缓存查询 + Stage2 sync stats 持久化 |
| `packages/core/src/modules/plugin/xray/xray_api.js` | xray CLI（lso/bi/bo/ado/rmo）封装 |
