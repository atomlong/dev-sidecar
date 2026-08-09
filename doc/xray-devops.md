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

## 运行时调试命令

Xray 启动后，可用 `xray api` 子命令查询运行时状态（需 xray 二进制在 PATH，或用 DS 内置的 xray 路径）。

> 所有命令都需要 `--server=127.0.0.1:<apiPort>`，`apiPort` 可在 `~/.dev-sidecar/running.json` 的 `api.listen` 字段查看（格式 `127.0.0.1:PORT`）。

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

## Xray-core 版本兼容性

DS 的 Phase 2 热刷新改动兼容 **Xray-core v26.3.27 及以上**：

| 依赖项 | v26.3.27 | v26.7.28 |
|--------|----------|----------|
| `api` 块（tag/listen/services） | ✅ | ✅ |
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
