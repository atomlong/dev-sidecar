# WebUI 配置改造规划（侧边栏 + 图形化配置编辑）

> 状态：已完成并部署上线（2026-09-02）。构建 `packages/gui` 的 `npm run electron:build -- --linux deb` → `sudo dpkg -i dist_electron/DevSidecar-*-amd64.deb` → `systemctl restart dev-sidecar`。
> 验证：webui 测试 61 项 + core 全量 172 项全绿；真实 configApi 墓碑语义在隔离 HOME 验证通过；生产 31182 真机全链路测试通过（GET 剥离、PUT 无损回环、局部树/非法 key 400、编辑-放弃回环、来源徽章、搜索、规则展开、xray restart 端点 8s 恢复）。
> 前置关联：[webui-api.md](webui-api.md)（现有 API 契约）、[webui-refactor-plan.md](webui-refactor-plan.md)（Vue 重建路线，独立立项，本次不启动）

## 1. 目标

1. 把「仪表盘 / 探测 / 缓存 / 日志 / 配置」5 个顶部标签改造为左侧侧边栏。
2. 「配置」页去掉 textarea 嵌入 JSON 的粗糙编辑方式，改为结构化 UI 组件（开关、输入、下拉、行列表的增删改）。
3. 编辑结果持久化，语义与 GUI 完全一致。

## 2. 关键决策

### 决策 A：写入位置 = `~/.dev-sidecar/config.json`（用户覆盖层），不动 `remote_config_personal.json5`

理由：

1. 合并顺序 `默认 → 远程共享 → 远程个人 → config.json`（`config/local-config-loader.js`），用户配置优先级最高，天然覆盖远程配置。
2. 删除语义完整：`doDiff` 把删除键写成 `null` 墓碑，合并时 `deleteNullItems` 剥除。删除一条来自远程配置的规则完全可行。
3. `remote_config_personal.json5` 是手工维护的带注释 JSON5，程序化重写会丢掉全部注释；且 `personalUrl` 指向真实远程时每 24h 自动下载会覆盖手改。
4. GUI 的「应用」就是 `configApi.save(整棵树)` → diff → config.json，WebUI 走同一条路。

远程个人配置的角色：手工维护的基础层。UI 为被 config.json 覆盖的字段显示「用户覆盖」徽章。

### 决策 B：本次在现有单文件原生 JS（`packages/gui/extra/webui/index.html`）上实现

不启动 Vue 重建（webui-refactor-plan.md 仍为独立路线）。预计文件 865 → ~3000 行（~130KB）。

## 3. 现状 bug（Phase 1 必须先修）

`PUT /api/config` 现实现为 `globalConfig.update(body)`：先 `lodash.mergeWith` 再 save。merge 无法删除键 → 前端删掉的键在 merge 阶段复活 → diff 认为无变化 → **删除静默失效**。
修复：改为 `configApi.save(整棵树)`（GUI 语义）。`PUT /api/intercepts`、`PUT /api/presetiplist`、`PUT /api/xray/rules` 同样中招，改为「clone 当前树 → `lodash.set` 整体替换子树 → save」。

## 4. 分阶段计划

### Phase 0：侧边栏布局

- `.nav` 顶部水平条 → 左侧 200px 垂直侧边栏（品牌区 + 导航项 + 底部版本号/WS 状态点）。
- 窄屏（<768px）回退为顶部水平条。
- JS 面板切换逻辑零改动。
- `routes.js` 静态文件路径加仓库内回退（开发态无 /opt 安装时可用）。

### Phase 1：配置地基

后端（`routes.js`）：

| 端点 | 内容 |
|---|---|
| `PUT /api/config`（修复） | 改为 `configApi.save(整树)`，要求 body 含 `app`/`server`/`plugin` 顶层键；响应带 `allConfig` |
| `GET /api/config`（修正） | 响应剥离 Xray 自动注入条目（`desc === 'Auto-injected by Xray Plugin'`）与 `configFromFiles` 调试快照 |
| `GET /api/config/user`（新增） | `{ userConfig, configPath, exists, remote: { enabled, hasPersonalUrl } }` — 值来源徽章数据 |
| `POST /api/config/reset`（新增） | body `{ key }`，`resetDefault(key)` → save → reload → reInject（对应 GUI 恢复默认） |
| `POST /api/xray/restart`（新增） | 包 `expose.api.plugin.xray.restart()` |

前端框架：

- 配置面板 = 左侧分区导航 + 右侧表单区 + 工具条（未保存更改计数 / 保存 / 放弃 / 恢复本区默认）。
- 状态模型：`GET /api/config`（已剥离）→ 深拷贝 `draft` → 控件 `data-path` 经路径 setter 写入 → 与 `original` 深比较计 dirty → 保存整树 PUT → 用响应 `allConfig` 重建。
- 保存联动：`plugin.xray.*` 或 `server.setting.xrayPort` 变更且 xray 在运行（`/api/xray/stage/status` liveNodes>0）→ 自动 `POST /api/xray/restart`。
- `api()` 补 `Authorization: Bearer` 头，401 时弹 token 输入框（localStorage 保存）。
- config 面板保持不自动刷新（`AUTO_REFRESH_SKIP`）。

### Phase 2：核心分区表单

| 分区 | 控件 |
|---|---|
| 加速服务·基本 | `server.enabled`/`intercept.enabled`/`script.enabled`/`verifySsl`/`NODE_TLS_REJECT_UNAUTHORIZED`/`allowTls12` 开关；`host` 文本；`port`、`defaultTimeout`/`defaultKeepAliveTimeout`/`lowSpeedDelay` 数字 |
| 拦截规则 | 见下方编辑器设计 |
| Xray 插件 | `enabled` 切换；`localPort`/`startupNodeLimit`/`maxDelayMs`/`bootstrapCandidateLimit`/`bootstrapProbeSamples`/`server.setting.xrayPort` 数字；`startupSelectEnabled`/`subscriptionSyncEnabled`/`cacheRefreshEnabled` 开关；`allowedCountries`/`allowedOwners` 标签输入（`!JP` 排除语法）；`cacheRefreshBatchLevel` 下拉 1-5；`subscriptionSyncLowWatermark`/`subscriptionSyncIntervalHours`/`subscriptionStaleAfterDays`/`cacheRefreshIntervalHours`/`cacheRefreshProbeSamples` 数字；`subscriptions`/`nodes` 行列表；路由规则行（domain + tag 下拉）；`probeUrl`/`observatoryProbeUrl` 文本 |
| 远程配置 | `app.remoteConfig.enabled` 开关；`url`/`personalUrl` 文本（http(s):// 或 file:// 校验）+ 立即更新按钮 |
| WebUI 自身 | `plugin.webui.enabled`/`port`/`listen`/`token` |

**拦截规则编辑器**（`server.intercepts`）：

```
域名列表（搜索、添加、重命名、删除）—— 过滤 metaInfo 不当域名
  └─ 选中域名 → 路径规则列表（添加、删除、重命名）
       └─ 每条规则：路径正则（new RegExp 实时校验）+ 动作字段编辑器
```

动作键集合（已从 mitmproxy `interceptor/impl/` 核实）：`proxy`(+`backup[]`+`test`)、`sni`、`redirect`、`abort`、`success`、缓存族（`cacheSeconds/Minutes/Hours/Days/Weeks/Months/Years`，数值+单位下拉，读时识别已用单位）、`script`、`tampermonkeyScript`、`requestReplace`/`responseReplace`（headers 键值对行，`[remove]` 哨兵提示）、`desc`/`remark`。值可为 `null`（墓碑，屏蔽默认配置继承键）→ 显示「已屏蔽」标记可恢复。未知键 → 折叠「高级字段」逐键编辑兜底。

### Phase 3：其余分区

| 分区 | 控件 |
|---|---|
| 预设 IP `preSetIpList` | 域名行 + IP 行（启用开关+删除） |
| 域名白名单 `whiteList` | 域名 + 不代理/代理下拉 |
| DNS | `providers`（server + forSNI）；`mapping` 行（域名 → provider 下拉 + IPv4/IPv6）；`speedTest`（开关/间隔/hostnameList/dnsProviders 多选） |
| 超时映射 `timeoutMapping` | 域名行 + timeout/keepAliveTimeout 数字 |
| 代理排除 `proxy.excludeIpList` | 域名行 + 开关；`excludeDomesticDomainAllowList` 开关；白名单 URL 文本 |
| 梯子 overwall | `enabled`、`targets` 行、`pac`（enabled/autoUpdate/pacFileUpdateUrl） |
| 网络检测 free-eye | `enabled` + `setting.config` Route/DNS/TCP/TLS 参数 |
| Git/Node/Pip | 开关 + 少量 setting |
| 应用与日志 | `autoStart`、`keepLogFileCount`、`maxLogFileSize`+单位、`logFileSavePath` |

### Phase 4：打磨

- 每分区「恢复默认」→ `POST /api/config/reset`（confirm 二次确认）。
- 只读「原始 JSON」折叠区（合并配置 + config.json diff），调试用，不可编辑。
- 测试：`packages/core/test/webui.test.js` 补 PUT 墓碑 / reset / user / 自动注入剥离 / restart。
- 文档：webui-api.md 补新端点；部署同步 `/opt/dev-sidecar/resources/extra/webui/index.html`。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| merge 无法删除键 | Phase 1 整树 save 语义 + 测试覆盖墓碑路径 |
| 自动注入条目污染 diff | GET 响应剥离 |
| 表单被 10s 自动刷新冲掉 | config 面板在 `AUTO_REFRESH_SKIP`；面板 DOM 不销毁，切分区不丢 draft |
| 未知键丢失 | 高级字段兜底编辑器 |
| 单文件膨胀 | 按分区函数 + 分节组织；预计 ~3000 行，仍远小于 Vue 方案 |

## 6. 验收标准

- 5 面板侧边栏切换正常，窄屏可用。
- 添加/删除/修改一条拦截规则 → config.json 出现对应 diff（删除远程来源规则 → `null` 墓碑），热重载生效。
- `plugin.xray.enabled` 等开关、路由规则行编辑可用；xray 变更保存后自动重启（运行中时）。
- 值被 config.json 覆盖的字段显示来源徽章。
- 现有 `pnpm --filter @docmirror/dev-sidecar test` 全绿。
