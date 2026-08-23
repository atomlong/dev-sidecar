# WebUI 重构规划

> 状态：规划中（未开始实施）
> 创建：2026-08-23
> 关联：v2.2.8 WebUI 监控面板、CPA（Cli-Proxy-API-Management-Center）架构参考

## 1. 背景与目标

### 1.1 背景

dev-sidecar v2.2.8 在 headless 服务器场景下新增了 WebUI 监控面板（`packages/gui/extra/webui/index.html`，端口 31182），用于无显示器环境的服务状态监控。当前实现是**单文件原生 HTML + 原生 JS（约 26KB，500 行）**，所有逻辑挤在一个文件里。

随着功能不断叠加（Dashboard / Xray / Cache / Stage / Logs / Config / Balancer / Sticky），单文件原生 JS 的维护成本快速上升，且缺失多项关键能力（版本展示、确认对话框、图表、i18n、主题、状态共享、响应式）。

### 1.2 参考案例

[CPA（Cli-Proxy-API-Management-Center）](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) 用 **React 19 + Vite + TypeScript + Zustand + i18next + Axios + motion + CodeMirror** 开发，通过 [`vite-plugin-singlefile`](https://github.com/richardtallent/vite-plugin-singlefile) 插件构建为**单文件 HTML（2.8MB，gzip 981KB）**，所有 JS/CSS 全内联，通过 GitHub Releases 发布 `management.html` 供用户下载。

**关键发现**：`vite-plugin-singlefile` + `assetsInlineLimit: 100MB` 让"现代前端栈 + 单文件部署"成为可能，部署链零改动（现有 dev-sidecar core 的 `http.Server` 直接返回该单文件即可）。

### 1.3 目标

- 用 Vue 3 + Vite + TypeScript 重构 WebUI，构建产物为单文件 HTML
- 部署链零改动：输出到 `packages/gui/extra/webui/index.html`，electron-builder 已打包此目录
- 补齐关键缺失能力：版本展示、确认对话框、图表、i18n、主题、状态共享、响应式、认证
- 与 GUI 包（Vue 3 + Ant Design Vue 4）技术栈对齐，复用组件/主题/构建经验
- 不破坏现有 core `http.Server` 的 `/` 路由和 `/api/*` 接口契约

### 1.4 非目标

- 不重构 GUI 包（`packages/gui/`）的 Electron + Vue 桌面端
- 不改 core 的 `/api/*` 接口契约（前端单向适配后端）
- 不做透明代理 / 移动端原生 App / 浏览器扩展

## 2. 现状分析

### 2.1 当前 WebUI 实现概览

| 维度 | 当前实现 | 文件 |
|---|---|---|
| 入口 | `packages/gui/extra/webui/index.html`（26KB，单文件原生 HTML+JS） | [index.html](packages/gui/extra/webui/index.html) |
| 后端 | `packages/core/src/modules/plugin/webui/`（http.Server + ws） | [index.js](packages/core/src/modules/plugin/webui/index.js)、[routes.js](packages/core/src/modules/plugin/webui/routes.js)、[ws.js](packages/core/src/modules/plugin/webui/ws.js) |
| 端口 | 31182（127.0.0.1） | `pluginConfig.port` |
| 部署 | electron-builder 打包 `extra/webui/` → `/opt/dev-sidecar/resources/extra/webui/` | [electron-builder.config.cjs](packages/gui/electron-builder.config.cjs) |

### 2.2 当前 WebUI 缺失能力

| 维度 | 现状 | 期望 |
|---|---|---|
| Dashboard 版本号 | ❌ 不显示 | ✅ `GET /api/version` + 最新版对比 |
| "重启服务"体验 | ⚠️ `process.exit(1)` 依赖 systemd `Restart=on-failure` + `RestartSec=15`，前端 15s 无反馈 | ✅ 进度遮罩 + 健康检查轮询 |
| 危险操作确认 | ❌ 无 | ✅ Modal.confirm 二次确认 |
| 错误处理 | ⚠️ 刚加 `api()` throw，但 catch 块不完整 | ✅ Axios 拦截器统一 toast |
| 状态共享 | ❌ 每次刷新全量 refetch | ✅ Pinia stores 跨页面共享 |
| 10s 刷新冲突 | ⚠️ 用户交互时仍刷新，表单被冲掉 | ✅ 交互时暂停刷新 |
| 图表 | ❌ 无 | ✅ ECharts 延时分布 / 存活率 / Stage 进度 |
| i18n | ❌ 硬编码中文 | ✅ vue-i18n 中英双语 |
| 主题 | ⚠️ 硬编码 dark | ✅ CSS 变量 + light/dark 切换 |
| 响应式 | ❌ 无 | ✅ Ant Design Grid + media query |
| 认证 | ❌ 任何能访问 31182 的人都能操作 | ✅ WebUI token + 登录页 |
| 加载/空/错误状态 | ⚠️ 部分 skeleton | ✅ 完整三态 |

### 2.3 已知 bug（v2.2.8 修复中）

- **解锁假成功**：浏览器缓存旧版 `api()` 函数（不检查 HTTP 错误），后端返回 500 时前端仍弹"已解锁"。已加 `Cache-Control: no-store` + `api()` throw 修复
- **observatory 真空期解锁**：启动后 5 分钟内 observatory 未探测，手动解锁后 balancer 无节点可选。已在 `disableSticky` 加 observatory alive 检查拒绝解锁
- **锁定状态下拉未禁用**：已加 `disabled` + `opacity:0.5`

## 3. 技术选型

### 3.1 框架：Vue 3（推荐）

| 维度 | Vue 3 | React 19 | 决策 |
|---|---|---|---|
| 与 GUI 复用 | ✅ GUI 已是 Vue 3 + Ant Design Vue 4 | ❌ 需引入新栈 | **Vue** |
| 状态管理 | Pinia（与 GUI 一致） | Zustand | Vue |
| UI 库 | Ant Design Vue 4（GUI 已用） | Ant Design | Vue |
| 路由 | Vue Router | React Router v7 | 平 |
| 构建产物 | vite-plugin-singlefile | vite-plugin-singlefile | 平 |
| 生态对齐 CPA | ❌ | ✅ 可直接借鉴结构 | React |
| 学习成本 | 与 GUI 团队共享 | 需学 React | Vue |

**结论**：**Vue 3**。GUI 包已是 Vue 3 + Ant Design Vue，可复用组件/主题/构建经验；CPA 的 React 结构作架构参考，不必照搬语言。

### 3.2 完整技术栈

- **构建**：Vite 5 + `vite-plugin-singlefile` + `assetsInlineLimit: 100MB`
- **框架**：Vue 3.5+（Composition API + `<script setup>`）
- **语言**：TypeScript 5
- **状态**：Pinia + `pinia-plugin-persistedstate`（持久化到 localStorage）
- **路由**：Vue Router 4
- **UI**：Ant Design Vue 4（按需引入）
- **HTTP**：Axios + 拦截器
- **i18n**：vue-i18n 9
- **图表**：ECharts 5（vue-echarts 封装）
- **动画**：`@vueuse/motion`
- **代码编辑**：vue-codemirror（Config 编辑用）
- **工具**：ESLint + Prettier + `@vue/eslint-config-typescript`

### 3.3 构建产物约束

- 单文件 HTML 大小目标：< 3MB（gzip < 1.2MB），与 CPA 持平
- 首次加载：< 2s（localhost，无外网依赖）
- 浏览器兼容：Chrome/Edge 90+、Firefox 90+、Safari 14+（headless 服务器用 Chromium 系访问）

## 4. 架构设计

### 4.1 整体架构

```
┌─ 开发态 ─────────────────────────────┐    ┌─ 构建态 ────────────┐    ┌─ 部署态 ─────┐
│ packages/webui/                     │    │ vite-plugin-       │ →  │ 单文件 HTML  │
│   src/                              │ →  │ singlefile 内联    │    │ 2-3MB       │
│     features/ components/ services/ │    │ 所有 JS/CSS 进 HTML│    │             │
│     stores/ router/ i18n/ styles/   │    └────────────────────┘    │ packages/   │
└────────────────────────────────────┘                                │ gui/extra/  │
                                                                      │ webui/      │
                                                                      │ index.html  │
                                                                      │     ↓       │
                                                                      │ electron-  │
                                                                      │ builder    │
                                                                      │ 打包 asar  │
                                                                      │     ↓       │
                                                                      │ core http.  │
                                                                      │ Server 返回 │
                                                                      └─────────────┘
```

### 4.2 目录结构

```
packages/webui/                        # 新增 pnpm workspace 包
├── package.json
├── pnpm-lock.yaml                     # 独立 lock，避免污染根
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── eslint.config.js
├── index.html                         # Vite 入口模板
├── scripts/
│   └── copy-to-gui.js                 # 构建后复制 dist/index.html → packages/gui/extra/webui/
└── src/
    ├── main.ts                        # 应用入口
    ├── App.vue                        # 根组件 + 全局布局
    ├── router/
    │   └── index.ts                   # Vue Router 路由表
    ├── stores/                        # Pinia
    │   ├── index.ts                   # createPinia + persist 插件
    │   ├── auth.ts                    # WebUI token + 登录态
    │   ├── theme.ts                   # 主题切换（light/dark）
    │   ├── language.ts               # 语言切换（zh/en）
    │   ├── notification.ts           # toast + 确认对话框
    │   ├── config.ts                  # 用户偏好（刷新间隔、列排序）
    │   └── xray.ts                    # Xray 状态缓存（节点/sticky/observatory）
    ├── services/
    │   ├── apiClient.ts              # Axios 单例 + 拦截器（token、错误、超时）
    │   ├── version.ts                # GET /api/version + GitHub Releases 最新版
    │   ├── status.ts                 # GET /api/status、/api/system
    │   ├── xray/
    │   │   ├── nodes.ts              # GET /api/xray/nodes
    │   │   ├── balancer.ts           # GET /api/xray/balancer、POST/DELETE /api/xray/sticky
    │   │   ├── cache.ts              # GET /api/xray/cache/*
    │   │   ├── stage.ts              # GET /api/xray/stage/*
    │   │   └── metrics.ts            # GET /api/xray/metrics
    │   ├── system.ts                 # POST /api/service/restart、GET /api/logs
    │   └── config.ts                # GET/PUT /api/config、/api/intercepts、/api/xray/rules
    ├── features/                     # 业务模块（每个独立目录）
    │   ├── dashboard/
    │   │   ├── DashboardPage.vue
    │   │   ├── components/            # VersionCard、StatusGrid、Sparkline、Meter
    │   │   ├── hooks/useDashboardOverview.ts
    │   │   └── types.ts
    │   ├── xray/
    │   │   ├── XrayPage.vue
    │   │   ├── components/            # NodeTable、BalancerCard、StickyControl
    │   │   ├── hooks/useXrayNodes.ts
    │   │   └── types.ts
    │   ├── cache/
    │   │   ├── CachePage.vue
    │   │   ├── components/            # StatsCards、CountryDistribution、NodeDetailTable、ProbedStats
    │   │   └── hooks/useCacheStats.ts
    │   ├── stage/
    │   │   ├── StagePage.vue
    │   │   └── components/            # ProgressTimeline、BatchList
    │   ├── logs/
    │   │   ├── LogsPage.vue
    │   │   └── composables/useLogStream.ts  # WebSocket 替代轮询
    │   ├── config/
    │   │   ├── ConfigPage.vue
    │   │   └── components/            # CodeMirrorEditor、InterceptEditor、RuleEditor
    │   └── system/
    │       ├── SystemPage.vue
    │       └── components/            # RestartButton、VersionInfo、HealthCheck
    ├── components/                    # 通用 UI
    │   ├── layout/
    │   │   ├── MainLayout.vue         # 侧边栏 + 顶栏 + 内容区
    │   │   ├── Sidebar.vue
    │   │   └── Header.vue
    │   ├── ui/                        # 通用组件（基于 Ant Design Vue 二次封装）
    │   │   ├── StatCard.vue
    │   │   ├── ErrorBoundary.vue
    │   │   ├── EmptyState.vue
    │   │   └── LoadingSkeleton.vue
    │   └── charts/
    │       ├── Sparkline.vue          # 趋势线
    │       ├── ThroughputChart.vue   # 吞吐量
    │       ├── Meter.vue              # 仪表盘
    │       └── HistogramChart.vue    # 延时分布
    ├── composables/                   # 跨 feature 复用的 hooks
    │   ├── useAutoRefresh.ts         # 自动刷新 + 交互暂停
    │   ├── useHealthCheck.ts         # 服务健康检查轮询
    │   └── useConfirm.ts             # 确认对话框
    ├── i18n/
    │   ├── index.ts                  # vue-i18n 配置
    │   └── locales/
    │       ├── zh-CN.json
    │       └── en-US.json
    ├── styles/
    │   ├── theme.css                 # CSS 变量（颜色、间距、字体）
    │   ├── global.css
    │   └── animations.css
    ├── types/
    │   ├── api.ts                    # API 响应类型
    │   └── domain.ts                 # 领域模型（Node、Cache、Stage）
    └── utils/
        ├── format.ts                 # formatDate、formatBytes、formatDelay
        └── constants.ts              # API 路径、刷新间隔、storage key
```

### 4.3 状态管理设计

#### Pinia Stores

| Store | 职责 | 持久化 |
|---|---|---|
| `auth` | WebUI token、登录态、`apiBase` | ✅ localStorage（token 用 obfuscatedStorage） |
| `theme` | `light` / `dark`，CSS 变量切换 | ✅ |
| `language` | `zh-CN` / `en-US` | ✅ |
| `notification` | toast 队列、确认对话框状态 | ❌ |
| `config` | 刷新间隔、列排序、列显隐偏好 | ✅ |
| `xray` | 节点列表、sticky 状态、observatory 状态（跨页面共享） | ❌ |

#### 状态流

```
用户操作 → Pinia action → service 调用 → Axios → /api/*
                                         ↓
                                     响应拦截器
                                         ↓
                                 更新 Pinia state
                                         ↓
                              Vue 响应式 → 组件更新
```

### 4.4 API 客户端设计

```ts
// services/apiClient.ts 设计要点
class ApiClient {
  private instance: AxiosInstance
  private apiBase: string       // 动态读取 window.location.origin
  private token: string         // 从 auth store 读取

  // 拦截器：
  // - 请求：注入 Authorization: Bearer <token>
  // - 响应：统一错误 toast + 401 跳登录页
  // - 超时：10s（健康检查用 3s）
  // - 重试：GET 幂等失败重试 1 次
}
```

### 4.5 路由设计

| 路径 | 页面 | 守卫 |
|---|---|---|
| `/login` | LoginPage | 公开 |
| `/dashboard` | DashboardPage | 需登录 |
| `/xray` | XrayPage | 需登录 |
| `/cache` | CachePage | 需登录 |
| `/stage` | StagePage | 需登录 |
| `/logs` | LogsPage | 需登录 |
| `/config` | ConfigPage | 需登录 |
| `/system` | SystemPage | 需登录 |
| `/` | 重定向 `/dashboard` | |
| `*` | 404 | |

### 4.6 部署链集成

#### 构建流程

```
1. pnpm --filter @docmirror/webui build
   → vite build → dist/index.html（单文件，2-3MB）
2. node scripts/copy-to-gui.js
   → 复制 dist/index.html → packages/gui/extra/webui/index.html
3. cd packages/gui && npm run electron:build -- --linux deb
   → electron-builder 打包 extra/webui/ 进 asar/extra
4. sudo dpkg -i DevSidecar-*.deb
   → /opt/dev-sidecar/resources/extra/webui/index.html
5. core http.Server 启动，/ 路由返回该文件
```

#### 现有 core 路由兼容

`packages/core/src/modules/plugin/webui/routes.js` 的 `/` 路由已读 `/opt/dev-sidecar/resources/extra/webui/index.html`，**无需改动**。只需确保构建产物文件名仍为 `index.html`。

### 4.7 认证设计

#### WebUI Token 机制

- core 启动时生成随机 token，写入 `~/.dev-sidecar/webui.token`（权限 0600）
- `/api/auth/login` 接口：POST `{ token }` → 验证 → 返回 JWT 或直接通过
- 前端登录页：输入 token → Axios 拦截器加 `Authorization: Bearer <token>`
- 失败：401 → 跳 `/login`
- 持久化：token 用 obfuscatedStorage（参考 CPA `secureStorage`）

#### 安全约束

- token 长度 ≥ 32 字符
- 登录失败 5 次锁定 60s
- 所有 `/api/*` 必须带 token（除 `/api/version`、`/api/auth/login`）

## 5. 实施阶段

### 阶段 A：搭骨架（3-4 天）

**目标**：可运行的空壳应用，能登录、路由跳转、显示空白页面。

- [ ] 新建 `packages/webui/` 包，加入 pnpm workspace
- [ ] `package.json` + `vite.config.ts`（含 `viteSingleFile`）+ `tsconfig.json`
- [ ] Vue 3 + TS + Ant Design Vue 按需引入跑通
- [ ] Pinia + `pinia-plugin-persistedstate`
- [ ] Vue Router 路由表（8 个路由 + login + 404）
- [ ] Axios `apiClient.ts` + 拦截器（token、错误、超时）
- [ ] `MainLayout.vue` + `Sidebar.vue` + `Header.vue`（参考 CPA MainLayout）
- [ ] `Login.vue` + 后端 `/api/auth/login` + token 生成
- [ ] `i18n/index.ts` + 中英双语占位
- `styles/theme.css` CSS 变量（light/dark）
- [ ] `scripts/copy-to-gui.js` 构建后复制
- [ ] 现有 `packages/gui/extra/webui/index.html` 备份为 `index.legacy.html`
- [ ] 验证：构建 → 部署 → 访问 31182 → 登录 → 路由跳转

### 阶段 B：迁移功能（5-7 天）

按现有 6 个面板逐个迁移，每个面板独立验证。

#### B.1 Dashboard（1 天）

- [ ] `VersionCard.vue`：调 `GET /api/version` 显示 `dev-sidecar vX.Y.Z (Node vX.Y.Z)`
- [ ] 最新版检查：调 `versionApi.checkLatest()` 对比 GitHub Releases
- [ ] `StatusGrid.vue`：Xray 状态、系统代理、服务器、Stage 状态（3 态：关/启动中/开）
- [ ] `Sparkline.vue`：流量趋势（若有 metrics）
- [ ] 骨架优先渲染 + 10s 自动刷新（交互暂停）

#### B.2 Xray（1 天）

- [ ] `NodeTable.vue`：Ant Table + 列排序 + 过滤（direct/block/metrics 过滤）
- [ ] 字段提取：protocol（`_TypedMessage_`）、address（`proxySettings.server`/`vnext`）、SNI（`securitySettings[0].serverName`）、transport（`streamSettings.protocolName`）、delay（`metricsRes.observatory`，ms）
- [ ] `BalancerCard.vue`：解析 `bi` 输出，显示当前选中节点
- [ ] `StickyControl.vue`：锁定/解锁按钮 + 时长下拉（5min/10min/30min/1h/24h/永久）
- [ ] 锁定时禁用下拉 + observatory 真空期禁用解锁（后端已挡）
- [ ] `Modal.confirm()` 解锁/锁定确认
- [ ] 解锁失败时 toast 显示后端错误消息

#### B.3 Cache（1 天）

- [ ] `StatsCards.vue`：7 张统计卡（总节点、DB 大小、国家数、已探测、最优节点等）
- [ ] `CountryDistribution.vue`：ECharts 饼图 + 列表
- [ ] `NodeDetailTable.vue`：分页表（`page`/`pageSize`/`sort` 参数），`sort=smart` 按延时升序
- [ ] `ProbedStats.vue`：已探测节点统计 + 国家分布

#### B.4 Stage（0.5 天）

- [ ] `ProgressTimeline.vue`：探测进度条 + 批次时间线
- [ ] `BatchList.vue`：当前批次 + 候选数 + 已注入
- [ ] "探测"状态从 `stage.isStageRunning` 读取

#### B.5 Logs（0.5 天）

- [ ] `useLogStream.ts`：用 `ws.js` 的 WebSocket 替代 10s 轮询
- [ ] 实时滚动 + 自动到底 + 暂停滚动（用户向上滚动时）
- [ ] 日志文件切换下拉（core.log / gui.log / server.log）
- [ ] 行数选择（200 / 500 / 1000）

#### B.6 Config（0.5 天）

- [ ] `ConfigPage.vue`：只读查看 + 编辑切换
- [ ] `CodeMirrorEditor.vue`：vue-codemirror + JSON5 语法高亮
- [ ] `InterceptEditor.vue`：拦截规则编辑
- [ ] `RuleEditor.vue`：Xray 路由规则编辑
- [ ] 保存前 `Modal.confirm()` 确认

#### B.7 System（0.5 天）

- [ ] `RestartButton.vue`：`Modal.confirm()` → POST `/api/service/restart`
- [ ] 进度遮罩：`Spin` + "重启中，预计 15s..."
- [ ] `useHealthCheck.ts`：每 2s 轮询 `/api/version`，恢复后关闭遮罩 + toast"已重启"
- [ ] `VersionInfo.vue`：当前版本 + 最新版对比 + 构建时间
- [ ] 健康指标：内存、CPU、运行时长（参考 CPA SystemPage）

### 阶段 C：精修（2-3 天）

- [ ] **图表**：ECharts 延时分布直方图、存活率趋势、Stage 进度曲线
- [ ] **动画**：`@vueuse/motion` 页面切换 reveal、数字 countUp
- [ ] **i18n**：所有文案抽到 locale 文件，中英双语完整覆盖
- [ ] **主题**：light/dark 完整切换，Ant Design Vue 主题适配
- [ ] **响应式**：Ant Grid + media query，移动端可用
- [ ] **错误边界**：`ErrorBoundary.vue` 全局错误捕获 + 友好提示
- [ ] **空状态**：每个表格/图表配 EmptyState
- [ ] **骨架**：每个异步区块配 LoadingSkeleton
- [ ] **性能**：路由懒加载（虽然单文件，但组件懒加载仍减少首屏渲染开销）
- [ ] **无障碍**：aria 标签、键盘导航、焦点管理

## 6. 关键改动点对比

| 当前痛点 | 修正方案 | 阶段 |
|---|---|---|
| Dashboard 不显示版本 | `VersionCard` 调 `GET /api/version` + GitHub Releases 对比 | B.1 |
| "重启服务"体验差 | `RestartButton` + 进度遮罩 + `useHealthCheck` 轮询 | B.7 |
| 危险操作无确认 | `Modal.confirm()` 全局确认 | A |
| 解锁假成功 | Axios 拦截器统一错误 + `Cache-Control: no-store` | A |
| observatory 真空期解锁 | 后端已挡 + 前端禁用按钮 + 提示 | B.2 |
| 锁定状态下拉未禁用 | `:disabled="isSticky"` | B.2 |
| 浏览器缓存旧版 | `Cache-Control: no-store`（已加）+ 构建产物文件名带 hash | A |
| 无错误处理 | Axios 拦截器 + toast | A |
| 无状态共享 | Pinia `xray` store 跨页面共享 | A |
| 10s 刷新冲掉表单 | `useAutoRefresh` 交互暂停 | B.1 |
| 无图表 | ECharts 4 类图表 | C |
| 无 i18n | vue-i18n 中英双语 | C |
| 无主题切换 | CSS 变量 + `theme` store | A |
| 无响应式 | Ant Grid + media query | C |
| 无认证 | WebUI token + 登录页 + 拦截器 | A |

## 7. 风险与权衡

### 7.1 单文件 HTML 体积

- **风险**：3MB 单文件，首次加载慢
- **缓解**：gzip 后 1.2MB；localhost 无外网延迟；浏览器 `Cache-Control: no-store` 但 ETag 仍可 304
- **权衡**：vs 当前 26KB，体积增 100 倍，但功能/可维护性提升 10 倍

### 7.2 与 GUI 包的依赖耦合

- **风险**：`packages/webui/` 与 `packages/gui/` 都用 Vue 3，可能误共享组件导致耦合
- **缓解**：`packages/webui/` 独立 `package.json`，不依赖 `packages/gui/`；通用组件复制而非引用
- **权衡**：放弃部分代码复用以保持包独立

### 7.3 认证复杂度

- **风险**：WebUI token 机制增加使用复杂度（用户需查 token）
- **缓解**：token 写入 `~/.dev-sidecar/webui.token`，首次访问时前端提示 `cat ~/.dev-sidecar/webui.token`
- **权衡**：安全 vs 便利。本地 127.0.0.1 场景可配置关闭认证（`plugin.webui.requireAuth: false`）

### 7.4 重启服务不可逆

- **风险**：`process.exit(1)` 后 systemd 15s 重启，期间用户可能误操作
- **缓解**：进度遮罩 + 健康检查轮询 + 遮罩期间禁用所有按钮
- **权衡**：不可逆操作必须强确认 + 强反馈

### 7.5 WebSocket 替代轮询

- **风险**：`ws.js` 已存在但未充分使用，Logs 改 WebSocket 可能引入新 bug
- **缓解**：保留 HTTP 轮询作为 fallback；WebSocket 断开自动降级
- **权衡**：实时性 vs 稳定性

## 8. 验收标准

### 8.1 阶段 A 验收

- [ ] `pnpm --filter @docmirror/webui build` 产出单文件 `dist/index.html` < 3MB
- [ ] 复制到 `packages/gui/extra/webui/index.html` 后 `electron:build` 打包成功
- [ ] 部署后访问 `http://127.0.0.1:31182/` 显示登录页
- [ ] 输入 token 后跳转 Dashboard，侧边栏 8 个菜单可跳转
- [ ] light/dark 主题切换生效
- [ ] 中英文切换生效

### 8.2 阶段 B 验收

- [ ] Dashboard 显示版本号 `dev-sidecar v2.2.8`
- [ ] Xray 页面显示 20 个节点 + 列排序 + 过滤
- [ ] Balancer sticky 锁定/解锁流程完整（含 observatory 真空期拒绝）
- [ ] Cache 页面 7 张卡 + 国家分布饼图 + 节点详情分页
- [ ] Stage 页面显示探测进度
- [ ] Logs 页面实时滚动
- [ ] Config 页面可查看 + 编辑 + 保存
- [ ] System 页面重启按钮 + 进度遮罩 + 健康检查恢复

### 8.3 阶段 C 验收

- [ ] ECharts 图表正常渲染
- [ ] 移动端（375px 宽度）布局不破
- [ ] Lighthouse 评分：Accessibility ≥ 90、Best Practices ≥ 90
- [ ] 所有文案有中英双语
- [ ] 全局错误边界捕获异常不白屏

## 9. 后端接口改动（最小）

为支持新前端，后端 `routes.js` 需补充的接口（保持现有接口不变）：

- [ ] `POST /api/auth/login` — 验证 token，返回登录态
- [ ] `GET /api/auth/check` — 验证当前 token 是否有效
- [ ] `GET /api/version` — 补充 `buildDate`、`gitCommit` 字段（响应头或 body）
- [ ] `GET /api/health` — 轻量健康检查（仅返回 `{ ok: true }`，无副作用，用于重启后轮询）
- [ ] `GET /api/latest-version` — 代理 GitHub Releases API，返回最新版本号
- [ ] WebSocket `/ws/logs` — 推送日志行（替代 `/api/logs` 轮询，可选）

**不改的接口**：`/api/status`、`/api/system`、`/api/xray/*`、`/api/service/restart`、`/api/config`、`/api/logs`、`/api/intercepts`、`/api/xray/rules` 全部保持现状。

## 10. 工时估算

| 阶段 | 工时 | 产出 |
|---|---|---|
| A 骨架 | 3-4 天 | 可登录的空壳应用 |
| B 功能迁移 | 5-7 天 | 7 个页面功能完整 |
| C 精修 | 2-3 天 | 图表/i18n/响应式/无障碍 |
| **合计** | **10-14 天** | **生产级 WebUI** |

## 11. 后续演进

- **插件化**：参考 CPA `features/plugins/`，支持第三方插件注入 WebUI 页面
- **多用户**：多 token + 权限分级（管理员/只读）
- **审计日志**：记录 WebUI 操作（谁在何时解锁/重启/改配置）
- **移动端 App**：基于同一 API 套壳 RN/Tauri Mobile
- **主题市场**：用户自定义主题 CSS
