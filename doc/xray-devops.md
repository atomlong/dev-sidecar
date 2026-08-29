# Xray 插件开发与运维说明

> 本节面向需要调试 Xray 插件运行时状态、或排查 Stage3 热刷新行为的开发者/运维人员，普通用户无需阅读。

## Stage3 热刷新机制（v2.2.4+）

### 背景
Xray 插件在 Stage3（后台运行时）会定期从缓存刷新节点列表。早期版本通过"重写 config.json + 重启 xray 进程"实现，重启期间（约 200ms+）会中断正在进行的连接。v2.2.4 起改为基于 HandlerService gRPC API 的动态增删，**不重启进程、不中断现有连接**。

### 工作原理
- 启动时 `gen_config.js` 生成 `api` 块（监听 `127.0.0.1:<apiPort>`），启用 `HandlerService` / `ObservatoryService` / `RoutingService` 三个服务
- `balancer.selector` 和 `observatory.subjectSelector` 使用前缀 `["proxy_"]`，通过 `strings.HasPrefix` 自动包含运行时新增的 `proxy_N` tag
- 路径 B（热刷新）调用 `xray api ado`（AddOutbound）和 `xray api rmo`（RemoveOutbound）动态更新节点
- `RemoveHandler` 只从 manager 的 map 删除 tag 引用，**不调用 handler.Close()**，已建立的连接继续完成，只是新连接不再路由到该 tag
- Observatory `background()` 每个探测周期调 `hs.Select(SubjectSelector)`，自动发现新增 outbound 并探测，自动清理已移除 outbound 的状态（v26.7.28+；v26.3.27 不清理但无害）
- API 调用失败时自动 fallback 到重启路径（Phase 1 行为），不会崩溃

### 日志关键词
在 `~/.dev-sidecar/logs/core.log` 中可看到：
- `Xray Stage3 后API热刷新: 添加 N 个节点` / `移除 N 个节点` — 动态增删成功
- `Xray Stage3 后API热刷新失败，回退到重启: <error>` — API 失败，已回滚到重启路径
- `Xray Stage3 后热刷新完成` — 无论 API 还是重启路径，最终完成

## Stage1 sticky 自动锁定时序（v2.2.8+）

启动时 Stage1 bootstrap 注入节点后，balancer 的 leastPing 策略还没有 observatory 数据（observatory 只在周期边界发现 ado 注入的新节点），此时若无锁定则**流量直接失败**（v2.2.6 起无 `fallbackTag: direct`，防止暴露真实 IP）。因此：

1. **Stage1 注入后立即锁定**延时最低的节点（`Xray 第一阶段已临时锁定出口节点: tag=proxy_N`）
2. **自动解锁带防护**：`probeInterval`（默认 300s）到期时先查 observatory alive 节点数——为 0 则**延长锁定 60s**（`延长锁定 60s (第 N/5 次)`，最多 5 次），有数据才解除，避免 leastPing 无数据可选
3. **热刷新移除锁定节点时改锁**：Stage3 轮末热刷新若移除了 sticky 锁定节点（`sticky 锁定节点 proxy_N 将被移除，稍后改锁新节点`），改为**锁定剩余节点中延时最低者**（数据来自 Stage3 刚探测的缓存），而非裸解锁
4. 手动解锁（WebUI 按钮 / `DELETE /api/xray/sticky`）在 observatory 无 alive 节点时会**拒绝**并提示等待

## Stage2 订阅抓取触发机制（v2.2.8+）

Stage2 不是定时调度，触发点有两个：
1. **服务启动时**：`start()` 后台触发一次（受 `subscriptionSyncLowWatermark` 水位与 24h 冷却双守卫）
2. **Stage3 每轮结束时**：距上次远端抓取超过 `subscriptionSyncIntervalHours`（默认 24h）则触发（`Xray Stage3 后触发 Stage2: 距上次远端抓取 Xh, 间隔 24h`）

> **历史缺陷提示**：v2.2.8 之前第 2 个触发点是死代码（守卫误用 `isStageRunning`，在 `refreshCacheFromCacheOnly` 体内恒为 true），长期不重启的服务订阅永不刷新、节点池逐渐枯竭。v2.2.8 修复后真实生效——**长期运行的服务首次会在日志中看到该触发**。

运行状态可经 WebUI 探测页或 `GET /api/xray/stage/status` 查看：`stage2.state`（off/idle/running）、`progress`（正在抓第几个订阅）、`fetched`（本轮已抓取节点数）、`nextTriggerAt`（预计触发时间）。

## mitmproxy 子进程内存诊断（SIGUSR2 堆快照）

mitmproxy Node 子进程带 `--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=~/.dev-sidecar/logs` 启动，疑似内存泄漏时随时取证：

```shell
MPID=$(pgrep -f 'mitmproxy.js' | head -1)
kill -USR2 $MPID   # 进程不会被杀死：写快照后恢复（stop-the-world ~秒级）
ls -lh ~/.dev-sidecar/logs/*.heapsnapshot
```

- 用 **Chrome DevTools**（`chrome://inspect` → Memory → Load）加载 `.heapsnapshot`，间隔取 3 份做**三快照法**对比，找 Retained Size 持续增长的对象
- 快照几十至几百 MB，取证后**及时删除**
- **只对 mitmproxy PID 发 USR2**——未加 flag 的进程（主进程/xray）收 USR2 会按 POSIX 默认行为被杀死
- 诊断报告无需信号：运行时 `process.report.writeReport()` 即可（将来可挂 WebUI 端点）
- 事件循环卡死时 JS 层信号 handler 也无法执行——取证要在进程存活时发信号

## 运行时调试命令

Xray 主进程启动后会开放两个本地调试端口，写入 `~/.dev-sidecar/running.json` 的 `app.status.plugin.xray`：
- `apiPort` — HandlerService/ObservatoryService/RoutingService gRPC 端口，供 `xray api` 子命令使用
- `metricsPort` — expvar metrics 端口，供 `curl /debug/vars` 查看运行时状态（含 observatory 节点延时）

```shell
# 查看当前端口
cat ~/.dev-sidecar/running.json | jq '.app.status.plugin.xray'
# {"enabled": true, "port": 10801, "apiPort": 45021, "metricsPort": 45022}
```

## 方式一：curl 查看 observatory 节点延时（推荐，上游官方版即可用）

主进程的 metrics 端口暴露 expvar，`observatory` 字段包含每个节点的 alive/delay/lastErrorReason：

```shell
# 查看所有节点状态
curl -s http://127.0.0.1:<metricsPort>/debug/vars | jq '.observatory'
# {
#   "proxy_0": {"alive": true, "delay": 142, "lastErrorReason": ""},
#   "proxy_1": {"alive": false, "delay": 99999999, "lastErrorReason": "the outbound proxy_1 is dead..."},
#   "proxy_2": {"alive": true, "delay": 187, "lastErrorReason": ""}
# }

# 只看 alive 节点的延时（表格形式）
curl -s http://127.0.0.1:<metricsPort>/debug/vars | \
  jq -r '.observatory | to_entries[] | select(.value.alive) | "\(.key)\t\(.value.delay)ms"'
# proxy_0   142ms
# proxy_2   187ms

# 只看 dead 节点的失败原因
curl -s http://127.0.0.1:<metricsPort>/debug/vars | \
  jq -r '.observatory | to_entries[] | select(.value.alive | not) | "\(.key)\t\(.value.lastErrorReason[:60])"'
# proxy_1   the outbound proxy_1 is dead: GET request failed:...
```

> `delay=99999999` 是 xray 对 dead 节点的哨兵值，`alive=false` 即可判断节点不可用。
> burst observatory 模式下字段结构相同，`delay` 是平均延时，另有 `healthPing` 子对象含详细统计。

## 方式二：`xray api` 子命令

需 xray 二进制在 PATH，或用 DS 内置的 xray 路径。所有命令都需要 `--server=127.0.0.1:<apiPort>`。

### `xray api lso` — 列出所有 outbound
```shell
xray api lso --server=127.0.0.1:45021
```
显示当前 xray 进程中所有 outbound 的 tag 和 protocol（静态定义 + 运行时动态添加的）。

### `xray api obs` — 查看 observatory 探测状态（fork 专有，上游未合并）
> 上游 XTLS/Xray-core PR #6604 已被关闭（maintainer 表示"obs 不打算再扩展"）。此命令仅存在于 fork [atomlong/Xray-core](https://github.com/atomlong/Xray-core) 的 `feat/api-observatory-status` 分支，需自行编译并替换 DS 内置的 xray 二进制（`~/.dev-sidecar/xray/xray`）后才可用。DS 自身不依赖此命令（通过 metrics API 读 observatory 数据），缺少它不影响任何功能，仅缺少一个调试手段。

```shell
xray api obs --server=127.0.0.1:45021
```
输出示例：
```
TAG                 ALIVE  DELAY(ms)  LAST_ERROR
---
proxy_0             yes    142        -
proxy_1             no     -          the outbound proxy_1 is dead: GET request...
proxy_2             yes    187        -
```
- `ALIVE=yes` 表示节点探测通过，`DELAY` 为最近一次探测的延迟
- `ALIVE=no` 的节点 `DELAY` 显示 `-`，`LAST_ERROR` 显示失败原因（截断到 60 字符）
- 加 `-json` 参数输出 protobuf JSON 格式
- 上游官方版（含 v26.7.28）无此命令；如需使用见上文 fork 说明

### `xray api bi` — 查看 balancer 选择状态
```shell
xray api bi --server=127.0.0.1:45021 balancer-proxy
```
显示 balancer 当前的 `Selects` 列表和 `Override`。需 `RoutingService` 已启用。

### `xray api bo` — 锁定/解锁 balancer 选择（Sticky）
```shell
# 锁定到 proxy_0（所有新连接走 proxy_0）
xray api bo --server=127.0.0.1:45021 -b balancer-proxy proxy_0

# 解除锁定，恢复 leastPing 自动选择
xray api bo --server=127.0.0.1:45021 -b balancer-proxy -r
```
`bo`（Balancer Override）强制 balancer 永远选择指定 outbound tag。用于保持出口 IP 不变（如 ChatGPT 注册场景）。需 `RoutingService` 已启用。

DS 内置 API 封装（`packages/core/src/modules/plugin/xray/index.js`）：
- `enableSticky({duration=300})` — 自动获取当前选中节点并锁定，`duration` 秒后自动解锁
- `disableSticky()` — 手动解除锁定
- `getStickyStatus()` — 返回 `{active, tag, apiPort}`

锁定期间 observatory 继续探测（不影响），只是 balancer 选择被固定。热刷新 rmo 删除锁定节点时自动解除；xray 重启时自动重置。

## Xray-core 版本兼容性

DS 的 Phase 2 热刷新改动兼容 **Xray-core v26.3.27 及以上**：

| 依赖项 | v26.3.27 | v26.7.28 |
|--------|----------|----------|
| `api` 块（tag/listen/services） | ✅ | ✅ |
| `metrics` 块（expvar /debug/vars） | ✅ | ✅ |
| `xray api ado/rmo/lso` | ✅ | ✅ |
| HandlerService / ObservatoryService gRPC | ✅ | ✅ |
| `Select` 前缀匹配 / `RemoveHandler` 不中断连接 | ✅ | ✅ |
| observatory 自动清理已移除 outbound 状态 | ❌（残留但无害） | ✅ |
| `xray api obs` 命令 | ❌ | ❌（上游 PR #6604 被关闭；仅 fork 有） |

v26.3.27 上运行时，已 `RemoveOutbound` 的 tag 旧 status 会残留在 observatory 内部状态里，但：
- 不影响 balancer 选择（balancer 实时查 manager，不查 observatory status）
- 不影响 DS 决策（DS 用独立 probe 进程做 Stage1 探测，Stage3 基于 cache 指纹比较）
- 仅影响 fork 专有的 `xray api obs` 调试输出（上游官方版无此命令，故无实际影响）

## 部署后首次重启

Phase 2 改动包含 config.json 格式变化（selector 从显式列表 `["proxy_0",...]` 改为前缀 `["proxy_"]`，新增 `api` 块）。这些只在 xray 进程下次启动时生效。**部署 v2.2.4 后建议手动重启一次 DS**，让 xray 加载新格式 config.json。之后的热刷新全走 API，不再重启 xray。
