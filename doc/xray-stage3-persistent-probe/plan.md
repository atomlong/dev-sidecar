# Stage3 探测子进程常驻化优化规划

> 状态：规划中，暂不实施
> 创建：2026-08-13
> 关联代码：`packages/core/src/modules/plugin/xray/probe.js`、`index.js`、`xray_api.js`、`gen_config.js`

## 1. 背景与动机

### 1.1 当前架构的成本结构

Stage3 一轮探测在 [index.js#L3283](../../packages/core/src/modules/plugin/xray/index.js#L3283) 的 `while (processedCount < totalDueCandidateCount)` 循环中逐批处理。每个批次做两件事，各自 spawn 独立的 xray 子进程：

**批次存活性探测** — [runSingleProbePass](../../packages/core/src/modules/plugin/xray/index.js#L2355)

| 步骤 | 当前实现 |
|------|----------|
| 生成临时 config | `config-${Date.now()}-${random}.json`，每批一个 |
| 端口分配 | 每批找 2 个空闲端口（probePort + metricsPort） |
| 启动子进程 | `spawn(binPath, ['-c', configPath])`（[probe.startProbeProcess](../../packages/core/src/modules/plugin/xray/probe.js#L184)） |
| 等待结果 | `waitForObservatoryMetrics` 轮询 `/debug/vars` |
| 清理 | `finally` 里 stopChild + `fs.rmSync` 删 config |

**出口 IP/country/owner 探测** — [annotateProbeEntries](../../packages/core/src/modules/plugin/xray/index.js#L1876) → [resolveEntryEgressMetadata](../../packages/core/src/modules/plugin/xray/index.js#L1800)

| 步骤 | 当前实现 |
|------|----------|
| 生成临时 config | `egress-${...}.json`，**每个活节点一个** |
| 端口分配 | 每节点找 1 个端口 |
| 启动子进程 | `spawn`，并发限制 4（[EGRESS_METADATA_CONCURRENCY](../../packages/core/src/modules/plugin/xray/index.js#L45)） |
| 等待就绪 | `waitForProxyPortReady`（每节点都等） |
| 探测出口 | `detectEgressAddressThroughProxy` |
| 清理 | stopChild + 删 config |

### 1.2 量化：一轮 Stage3 的 spawn 开销

以 40000 节点缓存、batchSize=128、约 0.3% 存活率（123/40000）为例：

| 项目 | 计算公式 | 次数 |
|------|----------|------|
| 批次探测 spawn | `ceil(40000 / 128)` | **313 次** |
| 批次 config 生成 + 写盘 | 同上 | 313 次 |
| 批次端口查找 | `313 × 2` | 626 次 |
| 出口 IP 探测 spawn | 活节点数 | **123 次** |
| 出口 config 生成 + 写盘 | 同上 | 123 次 |
| 出口端口查找 | 同上 | 123 次 |
| `waitForProxyPortReady` | 同上 | 123 次 |
| **总 spawn 次数** | | **~436 次/轮** |

### 1.3 关键发现：动态增删 API 已生产验证

[xray_api.js](../../packages/core/src/modules/plugin/xray/xray_api.js) 已实现：
- `addOutbounds` → `xray api ado`（HandlerService gRPC）
- `removeOutbounds` → `xray api rmo`
- `listOutbounds` → `xray api lso`

主 xray 进程的「后API热刷新」路径（[index.js#L2291](../../packages/core/src/modules/plugin/xray/index.js#L2291)）**已在生产环境长期使用** ado/rmo 增删代理节点。主 xray 的 [genConfig](../../packages/core/src/modules/plugin/xray/gen_config.js#L205) 同时配置了：
- `observatory`（regular，`enableConcurrency: true`）
- `apiPort`（services 含 `HandlerService`、`ObservatoryService`、`RoutingService`）
- `leastPing` balancer

这间接证明了核心前提：**observatory 会自动探测通过 `ado` 新增的 `proxy_*` 节点**——否则 balancer 的 leastPing 策略对热刷新加入的新节点根本拿不到 delay 数据。

---

## 2. 优化方案

### 2.1 方案 A：批次探测子进程常驻化（核心收益）

**目标**：一轮 Stage3 的所有批次共用一个常驻 xray 探测子进程，批次间用 `rmo` + `ado` 换节点，不重启。

**架构变化**：

```
当前：  批次1 → spawn → 探测 → stop → 批次2 → spawn → 探测 → stop → ...
优化后：spawn 一次（整轮）→ 批次1: rmo旧 + ado新 → 探测 → 批次2: rmo旧 + ado新 → 探测 → ... → stop
```

**改造点**：

1. **[probe.js](../../packages/core/src/modules/plugin/xray/probe.js)**：新增 `startPersistentProbeProcess`
   - genConfig 带上 `apiPort`（启用 HandlerService + ObservatoryService）
   - 固定端口（probePort + metricsPort + apiPort），整轮复用
   - 返回 controller，暴露 `swapBatch({ addOutbounds, removeTags })` 方法
   - 保留现有 `startProbeProcess` 作为回退

2. **[runSingleProbePass](../../packages/core/src/modules/plugin/xray/index.js#L2355)**：改为接收常驻 controller
   - 不再 spawn，改调 `xrayApi.removeOutbounds` 删上一批 + `xrayApi.addOutbounds` 加本批
   - **使用固定 tag 范围 `proxy_0` ~ `proxy_{batchSize-1}`**（关键：避免 observatory 残留累积）
   - 记录本批新增的 tag 集合
   - 等 observatory metrics 里这些 tag 全部出现 `delay>0 || last_try_time>0`

3. **[isObservationReady](../../packages/core/src/modules/plugin/xray/probe.js#L62)**：增加「按 tag 集合判断」模式
   - 当前是「所有 status 都探测过一次」
   - 常驻模式下需只看本批新增的 tag，避免被上一批残留 status 干扰
   - 新增参数 `expectedTags`（Set<string>），若传入则只检查这些 tag

4. **生命周期**：在 `refreshCacheFromCacheOnly` 的 round 入口启动常驻子进程，round 结束/异常/`generation` 变化时 stop

### 2.2 方案 B：出口 IP 探测子进程常驻化（次要收益）

**目标**：活节点的出口 IP 探测共用一个常驻 xray 子进程，每节点用 ado/rmo 切换，不 spawn。

**路由设计难点**：
- 当前 [resolveEntryEgressMetadata](../../packages/core/src/modules/plugin/xray/index.js#L1800) 用固定 `outboundTag: 'proxy_0'` 路由
- 常驻化后 tag 是动态的，两种方案：
  - **B1**：用 `balancer` + `selector: ['egress_']`，每节点 ado 一个 `egress_N`、rmo 上一个
  - **B2**：固定单 tag `egress_target`，每节点 `rmo` + `ado` 同 tag（需验证 xray 是否允许删除后立即重新添加同 tag）

### 2.3 方案 C：回退与崩溃恢复

- 常驻子进程 `ado`/`rmo` 失败 → 回退到一次性 spawn（保留现有 `runSingleProbePass` 逻辑）
- 常驻子进程意外退出 → 自动重启并重新加载本批节点
- 现有 [probe.stopChild](../../packages/core/src/modules/plugin/xray/probe.js#L87) 的 SIGTERM→SIGKILL 逻辑复用

---

## 3. 边界情况与异常处理

> **下文 3.1、3.2 的结论已通过实测验证（2026-08-13），见第 7 节实验报告。**

### 3.1 ✅ 异常节点导致 xray 子进程崩溃（风险已排除）

**场景**：某批节点中包含畸形配置（如 reality 参数错误、streamSettings 异常），导致 xray 启动即崩溃，或运行中 panic。

**实测结论**（见第 7 节实验 5-7）：**xray 的 `ado` 命令在添加节点前会验证配置，畸形配置被安全拒绝（exit 1），进程不崩溃。** 三种畸形配置测试全部被安全拒绝：

| 畸形类型 | xray 行为 | 进程状态 |
|----------|-----------|----------|
| 无效 protocol（`invalid_proto`） | `failed to build conf: unknown config id` | ✅ 存活 |
| vless 缺少必要字段（无 vnext） | `failed to build outbound handler` | ✅ 存活 |
| reality 错误 publicKey | `invalid "password": INVALID` | ✅ 存活 |

**这意味着**：常驻化方案的最大风险已被消除。异常节点不会导致常驻子进程崩溃，`ado` 的配置验证层提供了天然的保护。

**简化后的应对策略**：

| 层级 | 策略 | 说明 |
|------|------|------|
| L1 预防 | `ado` 的内置配置验证 | xray 自身已验证，畸形配置被拒绝 |
| L2 隔离 | `ado` 失败的节点返回错误，不阻塞批次 | 调用方记录失败节点，继续处理其他节点 |
| L3 降级 | 常驻子进程真正崩溃时（xray bug 等）回退到一次性 spawn | 保留现有 `runSingleProbePass` 逻辑 |
| L4 跳过 | 降级后仍失败 → 标记本批失败，跳到下一批 | 与当前行为一致 |

**关键结论**：不需要"自动定位坏节点"或"二分法"等复杂策略。`ado` 的内置验证足够可靠。

### 3.2 ✅ observatory 对动态换批的探测时序（已实测验证）

**实测结论**（见第 8 节实验 1-4、9-15）：

| 问题 | 实测答案 |
|------|----------|
| `rmo` 后 metrics 残留旧条目？ | **是，永久残留，不自动清除**（30s+ 仍存在） |
| `ado` 后 observatory 何时探测新节点？ | **约 1 个 probeInterval 周期后**（5s interval → 5-9s 后出现） |
| 探测是并发还是串行？ | **全并发**（`enableConcurrency: true`，128 节点在 1 个周期内全部完成探测） |
| 残留 status 的 delay 是否更新？ | **不更新**（被删除节点的 delay 停留在最后一次探测值） |
| 死节点的 status 格式？ | `alive=null, delay=99999999, last_seen_time=0, last_try_time>0` |
| `rmo` 后立即 `ado` 同名 tag？ | **完全可行**，observatory status 被新节点探测结果覆盖 |
| 大批量 ado（128 节点）？ | **104ms 完成**，无大小限制 |
| observatory 残留条目累积？ | **不固定 tag 会累积**（1829 条目 → 597MB HeapAlloc）；**固定 tag 复用不累积**（5 轮后仍 128 条目，21MB） |

**关键影响与设计决策**：

1. **`isObservationReady` 必须按 tag 集合过滤**（硬性要求）
   - rmo 后旧 status 永久残留，若按 "所有 status 都有 delay" 判断会永远为 true
   - 必须只检查本批 ado 成功的 tag 集合，忽略历史残留

2. **换批后有 5-10s 的探测等待期**（probeInterval=5s 时）
   - 这是 observatory 的固有行为，无法消除
   - 但与一次性 spawn 的等待时间基本相同（spawn 也要等 observatory 探测）
   - 常驻化的收益不在单批延迟，而在省去 spawn/config/端口查找的累积开销

3. **⚠️ 必须使用固定 tag 范围复用策略**（关键设计决策）
   - 若每批用不同 tag（proxy_0~127 → proxy_128~255 → ...），observatory 残留条目持续累积
   - 一轮 Stage3（313 批 × 128 = 40000 节点）会导致 ~40000 个残留条目，HeapAlloc 预估 >10GB
   - **解决方案**：每批都用 `proxy_0` ~ `proxy_127` 这 128 个固定 tag
     - 换批时先 `rmo proxy_0~127`，再 `ado proxy_0~127`（新节点配置）
     - 实测验证：5 轮换批后 observatory 仍只有 128 条目，HeapAlloc 21MB
     - `rmo` 后立即 `ado` 同名 tag 完全可行，status 被新节点覆盖

4. **死节点的 isObservationReady 判断**
   - 死节点：`delay=99999999, last_try_time>0`（已被探测过）
   - 当前判断 `delay > 0 || last_try_time > 0` 对死节点返回 true ✅（正确，死节点确实已被探测）
   - 无需修改判断逻辑，只需按 tag 集合过滤

5. **高频换批稳定**（见实验 8）
   - 4 轮换批（rmo 20 次 + ado 20 次）仅耗时 319ms（~40ms/次）
   - xray 进程全程存活，无崩溃

### 3.3 端口与资源管理

**当前**：每批找新端口，用完即弃
**常驻化后**：整轮固定 3 个端口（probe + metrics + api）

| 问题 | 应对 |
|------|------|
| 端口被占用（上一轮未释放） | 启动前检查，必要时 kill 占用进程 |
| 常驻子进程泄漏（round 异常退出未 stop） | `refreshGeneration` 变化时强制 stop；`api.close()` 里 stopTransientProbeControllers 已覆盖 |
| 隔离 cgroup 残留 | [probe.js#L271](../../packages/core/src/modules/plugin/xray/probe.js#L271) 的 `child.on('close')` 已 cleanup，复用即可 |

### 3.4 并发与竞态

| 场景 | 当前 | 常驻化后 |
|------|------|----------|
| `stopBackgroundProbe` 被调用 | 直接 stop currentProbe | 需 stop 常驻子进程 + 等待 ado/rmo 完成 |
| `api.close()` | stopTransientProbeControllers | 同上，需确保常驻子进程在 transient 集合里 |
| 两轮 Stage3 重叠 | `refreshGeneration` 防护 | 同上，新一轮启动前 stop 上一轮常驻子进程 |
| 用户手动触发刷新 | `++refreshGeneration` 使旧轮退出 | 常驻子进程需监听 generation 变化 |

**关键**：常驻子进程的 controller 必须注册到 `transientProbeControllers`，确保 `api.close()` 能清理。

### 3.5 方案 B 特有：出口 IP 探测的路由切换竞态

**场景**：常驻出口探测子进程正在 `ado egress_N` + 等待探测，此时上一节点的连接还未完全释放。

**风险**：
- xray 可能复用上一节点的连接池，导致出口 IP 探测到错误的节点
- `rmo` 后 xray 是否立即关闭该 outbound 的现有连接？

**应对**：
- 每次 ado 前先 rmo + 等待短暂时间（如 500ms）让连接关闭
- 或用唯一 tag（`egress_${nodeId}`），不复用 tag，避免连接池混淆
- 验证 xray `rmo` 是否有 `force` 选项强制关闭连接

### 3.6 部分节点 ado 失败（关键实现细节）

**场景**：本批 128 个节点，其中第 50 个 `ado` 失败（xray 不支持的配置）。

**实测结论**（见第 8 节实验 16、21）：

**ado 的行为是「遇到第一个无效节点就停止处理后续节点」**：
- 节点 0-49：成功添加
- 节点 50（无效）：失败，exit code 1
- 节点 51-127：**根本未被尝试**

**当前 `addOutbounds` 的问题**（[xray_api.js#L26](../../packages/core/src/modules/plugin/xray/xray_api.js#L26)）：
- `runXrayApi` 在 exit code ≠ 0 时 reject 整个 Promise
- 调用方认为整批失败，但实际有部分节点已添加
- 会导致状态不一致：内存中的 tag 映射与 xray 实际 outbounds 不匹配

**ado 输出格式**（可解析）：
```
adding: proxy_0
{}                    ← 成功标志（空 JSON）
adding: proxy_bad
                      ← 无 {}，stderr 有错误信息
```

**应对策略（三选一）**：

| 策略 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| A. 预过滤：ado 前用 `isParsedNodeValid` 过滤 | 简单 | 无法覆盖 xray 更严格的验证（如 reality publicKey） | ⭐⭐ |
| B. 逐个 ado：128 × 40ms = 5s | 精确知道每个节点结果 | 慢，抵消常驻化收益 | ⭐ |
| C. 解析 stdout：ado 后解析 `adding: <tag>\n{}` 判断成功 | 快且精确 | 依赖输出格式稳定性 | ⭐⭐⭐ |

**推荐方案 C**：改造 `addOutbounds` 返回 `{ results: [{ tag, success }] }`，通过解析 stdout 的 `adding: <tag>` + `{}` 模式判断每个节点是否成功。

**补充说明**：Stage3 已用 `parser.isParsedNodeValid` 过滤节点，无效节点概率低。但 xray 的 ado 验证更严格（如 reality publicKey 格式），策略 C 作为兜底保护。

### 3.7 rmo 性能瓶颈（关键实现细节）

**实测结论**（见第 8 节实验 20）：

| 操作 | 128 tags 耗时 | 单次耗时 |
|------|--------------|----------|
| 逐个 rmo（当前 `removeOutbounds` 实现） | **~2.5s** | ~20ms/tag |
| 并行 rmo（8 并发） | **~0.6s** | ~4.8ms/tag |
| ado 128 节点 | 104ms | — |

**问题**：当前 `removeOutbounds`（[xray_api.js#L39](../../packages/core/src/modules/plugin/xray/xray_api.js#L39)）逐个 rmo，128 tags 需 2.5s。加上 ado 104ms + 等 observatory 探测 5-8s，单批总耗时约 8-11s。如果 rmo 并行化，可省 1.9s。

**应对**：改造 `removeOutbounds` 支持并行 rmo（并发度 8-16），将 128 tags 的 rmo 从 2.5s 降到 ~0.6s。

**rmo 的幂等性**（实验 17-18 验证）：
- rmo 不存在的 tag：exit 0，无错误
- 重复 rmo 同一 tag：exit 0，无错误
- **无需检查 tag 是否存在即可安全 rmo**

### 3.7 observatory 探测 URL 的一致性

**当前**：每批的 probeConfig 用相同的 `probeUrl`（[index.js#L2494](../../packages/core/src/modules/plugin/xray/index.js#L2494)）
**常驻化后**：整轮用同一个 probeUrl，无变化

但需注意：如果 `probeUrl` 在运行中被用户修改，常驻子进程不会感知（当前一次性 spawn 会读最新配置）。

**应对**：常驻子进程启动时锁定 probeUrl，轮内不响应配置变化（与当前行为一致，当前也是批次启动时读取）。

---

## 4. 收益分析

### 4.1 定量收益

以 40000 节点、batchSize=128、123 活节点为例：

| 指标 | 当前 | 优化后 | 收益 |
|------|------|--------|------|
| 批次探测 spawn 次数 | 313 | 1 | **-99.7%** |
| 出口 IP 探测 spawn 次数 | 123 | 1 | **-99.2%** |
| 总 spawn 次数 | ~436 | ~2 | **-99.5%** |
| config 文件生成+写盘 | 436 次 | 2 次 | **-99.5%** |
| 端口查找次数 | 749 次 | 3 次 | **-99.6%** |
| `waitForProxyPortReady` 调用 | 123 次 | 1 次 | **-99.2%** |
| 临时文件 I/O | 436 次创建+删除 | 2 次 | **-99.5%** |

### 4.2 定性收益

**1. 启动延迟降低**
- 每次 spawn xray 子进程有 ~200-500ms 的进程启动开销（加载配置、初始化 observatory）
- 313 次批次 spawn ≈ 63-156 秒的纯启动开销
- 常驻化后只剩 1 次 ≈ 0.2-0.5 秒

**2. 文件系统压力降低**
- 436 次临时 config 创建+删除 → 2 次
- 减少 inode 分配、磁盘写入、`fs.rmSync` 系统调用
- 对 SSD 寿命和文件系统缓存友好

**3. 端口枯竭风险消除**
- 高频端口分配/释放可能导致 TIME_WAIT 堆积
- 常驻化后固定 3 个端口，无 TIME_WAIT 问题

**4. cgroup 隔离开销降低**
- 当前每次 spawn 都调 [moveProcessToIsolatedCgroup](../../packages/core/src/modules/plugin/xray/probe.js#L205)
- 436 次 cgroup 创建+清理 → 2 次

**5. 出口 IP 探测加速（方案 B）**
- 当前每节点需 `waitForProxyPortReady`（最多 5s）
- 常驻化后端口已就绪，省去等待
- 123 个节点 × 平均 1s 等待 ≈ 节省 123s（串行情况下）

**6. 可观测性提升**
- 常驻子进程的日志连续，便于追踪整轮探测
- 当前每批子进程日志独立，难以关联

### 4.3 收益的边界条件

收益大小取决于：

| 因素 | 收益大 | 收益小 |
|------|--------|--------|
| 缓存节点数 | 多（40000+） | 少（<1000） |
| 活节点比例 | 低（0.3%，spawn 多） | 高（>50%，活节点少） |
| batchSize | 小（128，批次多） | 大（1000+，批次少） |
| 单批探测耗时 | 短（observatory 快） | 长（probeInterval 大） |

**当前部署场景**（40000 节点、batchSize=128、低存活率）是收益最大的场景。

---

## 5. 风险与缓解

| 风险 | 等级 | 缓解 | 状态 |
|------|------|------|------|
| ~~observatory 对动态换批行为未知~~ | ~~🔴 高~~ | ~~阶段 0 实测验证~~ | ✅ 已验证（第 8 节） |
| ~~异常节点导致常驻子进程崩溃~~ | ~~🔴 高~~ | ~~分层恢复策略~~ | ✅ 已排除（ado 内置验证） |
| observatory 残留 status 导致误判 | 🟡 中 | isObservationReady 按 tag 集合过滤 | 设计已明确 |
| **observatory 残留条目累积导致内存爆炸** | **🔴 高** | **固定 tag 范围复用（proxy_0~127）** | ✅ 已验证策略有效 |
| 常驻子进程内存泄漏 | 🟡 中 | 每轮结束 stop；cgroup 隔离已有 | 待长期观察 |
| ado/rmo API 在高频调用下的稳定性 | 🟢 低 | 已压测：20 次 rmo+ado 耗时 319ms 无异常 | ✅ 已验证 |
| 方案 B 路由切换竞态 | 🟡 中 | 唯一 tag + rmo 后等待 | 待方案 B 实施时验证 |
| 代码复杂度增加 | 🟢 低 | 保留回退路径，灰度切换 | — |

---

## 6. 实施计划

### 阶段 0：验证脚本（已完成 ✅）

**目的**：验证 observatory 对动态增删节点的行为，回答 3.2 节的未知问题。

**执行时间**：2026-08-13
**方式**：启动独立测试 xray（模拟 Stage3 配置：probeInterval=5s + api + observatory），手动 ado/rmo，观察 metrics 行为。
**结果**：见第 7 节实验报告。所有关键问题已得到答案，方案 A 可行性已确认。

### 阶段 1：实施方案 A（批次探测常驻化）

**前提**：阶段 0 验证通过。

**步骤**：

1. `probe.js` 新增 `startPersistentProbeProcess`
   - 复用 `startXrayProcess`，genConfig 带 `apiPort`
   - 返回 `{ child, swapBatch, stop, promise }`
   - `swapBatch({ addOutbounds, removeTags })`：调 `xrayApi.removeOutbounds` + `xrayApi.addOutbounds`，返回本批 tag 集合
   - 监听 `child.on('close')`，崩溃时 reject 当前批次的 promise

2. `probe.js` 增强 `isObservationReady`
   - 新增参数 `expectedTags`（Set<string>）
   - 若传入，只检查这些 tag 的 status，忽略其他
   - 不影响现有调用（向后兼容）

3. `index.js` 改造 `runSingleProbePass`
   - 新增参数 `persistentController`（可选）
   - 若传入：调 `swapBatch` + `waitForObservatoryMetrics`（按 tag 过滤）
   - 若未传入：走现有 spawn 逻辑（回退）

4. `index.js` 改造 `refreshCacheFromCacheOnly`
   - round 入口：尝试启动常驻子进程
   - 启动失败 → 走现有逻辑（完全回退）
   - round 结束/异常/generation 变化 → stop 常驻子进程
   - 常驻子进程崩溃 → 标记本批失败，降级到一次性 spawn 完成剩余批次

5. 测试：`instanceTest.js` 增加常驻探测的单元测试

### 阶段 2：实施方案 B（出口 IP 探测常驻化）

**前提**：阶段 1 稳定运行。

**步骤**：

1. 决定路由方案（B1 balancer vs B2 固定 tag）—— 取决于阶段 0 对 rmo 后连接行为的观察
2. `resolveEntryEgressMetadata` 改为接收常驻 controller
3. `waitForProxyPortReady` 仅首次调用
4. 并发模型：单常驻子进程串行 vs 多常驻子进程并发

### 阶段 3：灰度发布

- 配置开关 `stage3PersistentProbe: true/false`（默认 false）
- 在个人 remote_config 先开，观察 1-2 轮 Stage3
- 确认稳定后默认开启

---

## 7. 待讨论的开放问题

1. ~~observatory 残留 status~~ → ✅ 已验证：rmo 后永久残留，isObservationReady 必须按 tag 过滤（实验 4）

2. ~~崩溃节点定位~~ → ✅ 已排除：ado 内置配置验证，畸形节点被安全拒绝（实验 5-7）

3. **方案 B 的并发度**：出口 IP 探测当前并发 4，常驻化后是串行还是保持并发？串行可能慢，并发需要多个常驻子进程。

4. ~~probeInterval 的影响~~ → ✅ 已验证：ado 后约 1 个 probeInterval（5s）后开始探测新节点，tag 复用后需 7-8s（实验 19）。

5. ~~ado 的原子性~~ → ✅ 已验证：ado **不是原子操作**，遇到第一个无效节点就停止后续处理（实验 16、21）。需改造 `addOutbounds` 解析 stdout。

6. ~~与主 xray 热刷新的共存~~ → ✅ 已验证：Stage3 常驻探测子进程用独立端口，与主 xray 的 api 端口不冲突。

7. ~~rmo 的错误处理~~ → ✅ 已验证：rmo 完全幂等，不存在的 tag 返回 exit 0（实验 17-18）。

8. ~~rmo 性能~~ → ✅ 已验证：逐个 rmo 128 tags 需 2.5s，需并行化（实验 20）。

---

## 8. 实验报告（2026-08-13）

### 实验环境

- xray 版本：v26.3.27（`/opt/dev-sidecar/resources/extra/xray/xray`）
- 测试配置：独立 xray 进程，probeInterval=5s，enableConcurrency=true，api + metrics + observatory
- 端口：probe=49900, api=49901, metrics=49902

### 实验 1-2：ado 后 observatory 探测时序

**操作**：ado 添加 3 个节点（proxy_0,1,2），每 2-3s 采样 observatory。

**结果**：

| 时间 | proxy_0 | proxy_1 | proxy_2 |
|------|---------|---------|---------|
| t+0s | NOT_IN_OBS | NOT_IN_OBS | NOT_IN_OBS |
| t+3s | NOT_IN_OBS | NOT_IN_OBS | NOT_IN_OBS |
| t+6s | delay=783 | NOT_IN_OBS | NOT_IN_OBS |
| t+9s | delay=783 | delay=1451 | delay=1532 |
| t+12s | delay=544 | delay=1451 | delay=1532 |

**结论**：
- ado 后约 1 个 probeInterval（5-6s）后 observatory 开始探测新节点
- 探测是渐进的（proxy_0 先于 proxy_1,2），但同一周期内的节点会在同一秒被探测
- `enableConcurrency=true` 生效

### 实验 3-4：rmo 后 observatory status 清理

**操作**：rmo 删除 proxy_0，每 2-3s 采样 observatory，持续 30s+。

**结果**：

| 时间 | proxy_0（已删除） | proxy_1（存活） | proxy_2（存活） |
|------|-------------------|-----------------|-----------------|
| t+0s | STILL_IN_OBS delay=543 | delay=1519 | delay=1481 |
| t+15s | STILL_IN_OBS delay=543 | delay=1440 | delay=1467 |
| t+30s | STILL_IN_OBS delay=543 | delay=1462 | delay=1462 |

**结论**：
- **rmo 后 observatory status 永久残留，不自动清除**（30s+ 仍存在）
- 被删除节点的 delay 停留在最后一次探测值，不再更新
- 存活节点的 delay 继续按 probeInterval 更新
- **isObservationReady 必须按 tag 集合过滤**

### 实验 5-7：异常节点 ado 行为

**操作**：ado 三种畸形配置节点。

| 畸形类型 | ado 输出 | exit code | xray 进程 |
|----------|----------|-----------|-----------|
| 无效 protocol | `unknown config id: invalid_proto` | 1 | ✅ 存活 |
| vless 缺少 vnext | `"vnext" should have one and only one member` | 1 | ✅ 存活 |
| reality 错误 publicKey | `invalid "password": INVALID` | 1 | ✅ 存活 |

**结论**：
- **xray 的 ado 命令在添加节点前会验证配置，畸形配置被安全拒绝**
- **xray 进程不受影响，不崩溃**
- 常驻化方案的最大风险已被消除

### 实验 8：高频换批压测

**操作**：4 轮换批，每轮 rmo 5 个旧节点 + ado 5 个新节点（共 rmo 20 次 + ado 20 次）。

**结果**：
- 总耗时：319ms（~40ms/次 rmo+ado）
- xray 进程：✅ 全程存活
- observatory：旧批 status 持续残留（与实验 4 一致）

**结论**：
- **高频换批稳定可靠**
- rmo+ado 单次操作约 40ms，远快于 spawn 一次新进程（200-500ms）
- 常驻化在操作层面有 5-10 倍的速度优势

### 实验 9：死节点的 observatory status 格式

**操作**：ado 一个必然连不上的 trojan 节点（10.255.255.1 不可路由），观察 status。

**结果**：

| 时间 | alive | delay | last_try_time | last_seen_time |
|------|-------|-------|---------------|----------------|
| t+0s | NOT_IN_OBS | — | — | — |
| t+5s | NOT_IN_OBS | — | — | — |
| t+10s | **null** | **99999999** | 1786598445 | **0** |
| t+30s | null | 99999999 | 1786598465 | 0 |

**结论**：
- 死节点：`alive=null, delay=99999999, last_seen_time=0, last_try_time>0`
- 与活节点（`alive=true, delay>0, last_seen_time>0`）格式不同
- `isObservationReady` 的 `delay > 0 || last_try_time > 0` 对死节点返回 true ✅（正确，已被探测）

### 实验 10-11：大批量 ado（128 节点）

**操作**：一次 ado 128 个节点（45KB JSON），计时并观察 observatory 探测时序。

**结果**：
- ado 128 节点耗时：**104ms**
- observatory 探测：t+0s（第一个采样点）时 128 个节点已全部探测完成
- 全部 alive=128, dead=0

**结论**：
- **128 节点 ado 无大小限制，耗时 104ms**
- `enableConcurrency=true` 确实全并发，128 节点在 1 个 probeInterval（5s）内全部探测完成
- 与 3 节点（5-9s）对比，说明并发度不受节点数量限制

### 实验 12：rmo 后立即 ado 同名 tag

**操作**：ado proxy_reuse（节点A）→ 等 8s → rmo proxy_reuse → 立即 ado proxy_reuse（节点B）→ 等 8s。

**结果**：

| 步骤 | exit code | observatory status |
|------|-----------|-------------------|
| 第一次 ado（节点A） | 0 | `alive=true, delay=2228` |
| rmo | 0 | 残留（不变） |
| 第二次 ado（节点B） | 0 | `alive=true, delay=1640`（新节点覆盖旧 status） |

**结论**：
- **rmo 后立即 ado 同名 tag 完全可行**
- observatory status 被新节点的探测结果覆盖
- 这使「固定 tag 范围复用」策略成为可能

### 实验 13-14：内存增长趋势（不固定 tag）

**操作**：10 轮换批，每轮用不同 tag（proxy_400~527, proxy_528~655, ...），观察内存和 observatory 条目。

**结果**：

| 时间点 | HeapAlloc | HeapObjects | obs entries |
|--------|-----------|-------------|-------------|
| 基线 | 134.8MB | 430566 | 130 |
| 10 轮后 | 128.8MB | 475116 | 525 |
| +20 批（~1829 entries） | **597.6MB** | — | 1829 |
| rmo 2600 个节点后 | **1546.6MB** | 5847357 | 2604 |

**结论**：
- **不固定 tag 会导致 observatory 残留条目持续累积**
- 1829 条目 → 597MB HeapAlloc
- rmo 操作本身也消耗内存（1546MB），且 rmo 不回收 observatory 残留
- **一整轮 Stage3（40000 节点）会导致内存爆炸**

### 实验 15：固定 tag 范围复用策略

**操作**：5 轮换批，每轮都用 `proxy_0` ~ `proxy_127`（rmo 上一批后 ado 新一批，复用 tag）。

**结果**：

| 时间点 | HeapAlloc | obs entries |
|--------|-----------|-------------|
| 基线（新启动） | ~5MB | 0 |
| 5 轮固定 tag 复用后 | **21.0MB** | **128** |

**结论**：
- **固定 tag 复用策略完美解决残留累积问题**
- 5 轮后 observatory 仍只有 128 条目（不增长）
- HeapAlloc 仅 21MB（vs 不固定 tag 的 597MB）
- **方案 A 必须使用固定 tag 范围复用策略**

### 实验 16、21：混合有效+无效节点的 ado（部分失败处理）

**操作**：一次 ado 混合 3 个有效 + 1-2 个无效节点。

**结果**：

```
adding: proxy_0
{}                    ← 成功
adding: proxy_1
{}                    ← 成功
adding: proxy_2
{}                    ← 成功
adding: proxy_bad1
failed to build conf: ...  ← 失败，exit 1
（proxy_bad2 从未被尝试）
```

**结论**：
- **ado 遇到第一个无效节点就停止，后续节点不被处理**
- exit code 1，当前 `addOutbounds` 会 reject 整个 Promise
- 但之前成功添加的节点已在 xray 中（状态不一致风险）
- ado 输出可解析：`adding: <tag>\n{}` = 成功，`adding: <tag>\n` + stderr = 失败

### 实验 17-18：rmo 的幂等性

**操作**：rmo 不存在的 tag；重复 rmo 同一 tag。

**结果**：
- rmo `proxy_nonexistent`（不存在）：exit 0，无错误
- 第二次 rmo `proxy_0`（已删除）：exit 0，无错误

**结论**：
- **rmo 完全幂等**，无需检查 tag 是否存在
- 简化了换批逻辑：直接 rmo 所有固定 tag，无需跟踪哪些实际存在

### 实验 19：tag 复用后 observatory 重新探测时序

**操作**：ado proxy_0（节点A）→ 等 8s → rmo proxy_0 → 立即 ado proxy_0（节点B）→ 逐秒采样。

**结果**：

| 时间 | delay | last_try_time | 说明 |
|------|-------|---------------|------|
| t+0~6s | 1786（旧） | 1786599839（旧） | 旧 status 未更新 |
| t+7s | 2592（新） | 1786599848（新） | 新节点被探测 |

**结论**：
- rmo+ado 同名 tag 后，observatory 需 **7-8 秒**（1 个 probeInterval + 注册开销）才重新探测
- 这与初始 ado 的 5-9s 延迟基本一致
- 换批后的等待时间与一次性 spawn 相当，不影响收益

### 实验 20：rmo 性能（逐个 vs 并行）

**操作**：rmo 10 个 tag，对比逐个和并行（8 并发）。

**结果**：
- 逐个 rmo 10 tags：**200ms**（20ms/tag）
- 并行 rmo 10 tags：**48ms**（4.8ms/tag）
- 推算 128 tags：逐个 ~2.5s，并行 ~0.6s

**结论**：
- 逐个 rmo 128 tags 需 2.5s，是 ado（104ms）的 24 倍
- **需改造 `removeOutbounds` 支持并行 rmo**，将 2.5s 降到 0.6s

---

## 9. 结论

阶段 0 实验已全部完成（21 组实验），所有关键技术细节得到明确答案：

1. **observatory 对动态增删的行为已验证**：ado 后 1 个周期探测新节点，rmo 后 status 永久残留
2. **异常节点不会导致崩溃**：ado 内置配置验证，畸形配置被安全拒绝
3. **高频换批稳定**：20 次 rmo+ado 耗时 319ms，无异常
4. **128 节点大批量 ado 可行**：104ms 完成，observatory 全并发探测
5. **rmo 后同名 tag 可立即重加**：observatory status 被新节点覆盖
6. **⚠️ 必须使用固定 tag 范围复用**：不固定 tag 会导致 observatory 残留累积和内存爆炸（1829 条目 → 597MB）；固定 tag 复用不累积（5 轮后仍 128 条目，21MB）
7. **死节点 status 格式明确**：`alive=null, delay=99999999, last_seen_time=0`，isObservationReady 现有逻辑兼容
8. **⚠️ ado 遇到无效节点会停止后续处理**：需改造 `addOutbounds` 解析 stdout 返回逐节点结果
9. **rmo 完全幂等**：rmo 不存在的 tag 或重复 rmo 都返回 exit 0
10. **tag 复用后重新探测需 7-8s**：与初始 ado 延迟相当，不影响收益
11. **rmo 性能瓶颈**：逐个 rmo 128 tags 需 ~2.5s，需并行化优化

方案 A（批次探测常驻化）在技术上**完全可行**，所有关键风险已识别并有应对策略。建议进入阶段 1 实施。

## 10. 实施前需改造的现有代码

基于实验发现，实施前需先改造以下现有代码（这些改造独立于常驻化方案，且对现有主 xray 热刷新路径也有益）：

| 文件 | 改造点 | 原因 |
|------|--------|------|
| [xray_api.js](../../packages/core/src/modules/plugin/xray/xray_api.js) | `addOutbounds` 返回逐节点结果 | ado 遇无效节点会停止，需知道哪些成功 |
| [xray_api.js](../../packages/core/src/modules/plugin/xray/xray_api.js) | `removeOutbounds` 支持并行 | 逐个 rmo 128 tags 需 2.5s，并行可降到 0.6s |
| [probe.js](../../packages/core/src/modules/plugin/xray/probe.js) | `isObservationReady` 支持 tag 集合过滤 | 常驻模式下只看本批 tag，忽略残留 |