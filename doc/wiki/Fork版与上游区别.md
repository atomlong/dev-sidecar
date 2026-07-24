# Fork 版与上游区别

本仓库 (`atomlong/dev-sidecar`) 是 [`docmirror/dev-sidecar`](https://github.com/docmirror/dev-sidecar) 的 Fork，基于上游 `master` 分支，在 `develop` 分支上开发。

> **核心原则**：dev-sidecar 的代理**不是都走 Xray**。Xray 只是 fork 新增的**可选**插件之一，默认关闭。绝大多数流量仍走上游原有的 MITM 拦截 + SNI 伪装 + 预设 IP + DNS 优化机制。Xray 仅在用户显式启用并配置节点后，对 `rules` 中匹配的域名走隧道代理。

---

## 1. 架构总览对比

```
上游 (docmirror/dev-sidecar)
├── core: MITM 拦截 + SNI 伪装 + 预设 IP + DNS 优化
├── 插件: git, node, pip, overwall(PAC 翻墙), free-eye
└── 无 Xray，无 Linux 原生打包

Fork (atomlong/dev-sidecar)
├── core: 继承上游全部能力 + 内存优化 + systemd 集成
├── 插件: 上游插件 + Xray(可选隧道代理) + overwall(默认关闭)
├── mitmproxy: 新增 requestReplace 拦截器 + WebSocket 升级改造 + tunnel agent + CA 证书透传
├── fadvise-linux: 新增 N-API 原生模块（POSIX_FADV_DONTNEED 释放页缓存）
├── gui: Linux deb 打包 + systemd service + Xray 二进制下载 + 原生模块重建
└── submit.sh: 私有/公有分支分离提交工具
```

---

## 2. 新增：Xray 插件（可选隧道代理）

### 定位
- **路径**：`packages/core/src/modules/plugin/xray/`
- **默认状态**：`enabled: false`（不启用时不加载、不启动进程、零开销）
- **作用**：为指定域名提供本地 Xray 隧道代理（VLESS/VMess/Trojan/Shadowsocks），用于访问 OpenAI、ChatGPT 等严格封锁区域

### 与上游 overwall 插件的区别

| 特性 | 上游 overwall | Fork Xray |
|------|--------------|-----------|
| 机制 | PAC 脚本 + HTTP 代理 | 本地 Xray 进程 + SOCKS/HTTP 隧道 |
| 协议 | HTTP 代理（明文 CONNECT） | VLESS/VMess/Trojan/SS（加密） |
| 节点来源 | 固定 PAC 列表 | 订阅链接 + 手动节点 |
| 默认状态 | `enabled: true`（上游默认开） | `enabled: false`（fork 默认关） |
| 适用场景 | 轻量翻墙 | 严格封锁站点（OpenAI 等） |

> Fork 中 overwall 插件**仍保留**但 `enabled: false`，由 Xray 替代其翻墙职能。

### Xray 工作原理（启用时）
1. fork 启动本地 Xray 子进程，监听自动分配的端口
2. mitmproxy 的 `proxy` 拦截器识别 `tunnel://` 协议，通过 `tunnel-agent` 建立 CONNECT 隧道到本地 Xray
3. Xray 根据路由规则将流量转发到远程节点
4. **仅 `rules` 配置中匹配的域名走 Xray**，其余域名仍走原有 MITM/SNI/直连

### Xray 插件模块构成
```
packages/core/src/modules/plugin/xray/
├── index.js          # 插件入口（启动/停止/规则注入）
├── config.js         # 默认配置
├── process.js        # Xray 子进程管理
├── gen_config.js     # 生成 Xray config.json
├── cache.js          # 节点缓存（SQLite）
├── parser.js         # 订阅链接解析
├── probe.js          # 节点延迟/可用性探测
├── geoip.js          # 节点地理位置
├── network_guard.js  # 网络守卫（stage gating）
├── port-finder.js    # 可用端口查找
├── util.cgroup.js    # cgroup 路径工具
└── test-helpers.js   # 测试辅助
```

详见 [Xray插件使用说明.md](Xray插件使用说明.md)。

---

## 3. 新增：mitmproxy 拦截器改造

### 3.1 requestReplace 拦截器（fork 新增）
- **文件**：`packages/mitmproxy/src/lib/interceptor/impl/req/requestReplace.js`
- **作用**：在请求发出前替换/删除请求头和查询参数
- **变量支持**：`${hostname}` `${host}` `${method}` `${path}` `${protocol}` `${port}` `${url}`
- **典型用途**：
  - 给 Cygn Worker 代理加 `X-Target-Host: ${hostname}` 头
  - 给 Bing 加 `X-Forwarded-For: 8.8.8.8` 骗过地理重定向
  - 删除/伪造 `Referer` `Origin` 绕过防盗链
- **配置示例**：
  ```json5
  ".*": {
    "proxy": "proxy.cygn.eu.org",
    "sni": "proxy.cygn.eu.org",
    "requestReplace": {
      "headers": {
        "X-Target-Host": "${hostname}",
        "X-Forwarded-For": "8.8.8.8"
      }
    }
  }
  ```

### 3.2 proxy 拦截器改造（fork 修改）
- **文件**：`packages/mitmproxy/src/lib/interceptor/impl/req/proxy.js`
- **新增**：支持 `tunnel://` 协议——当 `proxy` 值以 `tunnel://` 开头时，通过 `tunnel-agent` 建立 CONNECT 隧道到本地 Xray 端口，而非直接 HTTP 转发
- **改进**：SNI + `unVerifySsl` 逻辑更健壮，正确处理 `rOptions.agent` 为 undefined 的情况，https 请求显式设置 `rejectUnauthorized: false`

### 3.3 WebSocket 升级处理改造（fork 重写）
- **文件**：`packages/mitmproxy/src/lib/proxy/mitmproxy/createUpgradeHandler.js`
- **上游问题**：上游的 `upgradeHandler` 不支持请求拦截/代理转发，直接用原始 Host 连接目标，导致 Copilot 聊天的 WebSocket 连接失败
- **Fork 改造**（+198 行）：支持 intercepts 规则匹配、proxy 转发、SNI 伪装、tunnel agent，使 WebSocket 升级请求与普通 HTTP 请求走相同的拦截管道
- **测试**：`packages/mitmproxy/test/createUpgradeHandlerTest.js`

### 3.4 createRequestHandler 改造
- **文件**：`packages/mitmproxy/src/lib/proxy/mitmproxy/createRequestHandler.js`
- **改进**：keep-alive 复用 socket 时的连接超时处理——检查 `socket.writable && !socket.connecting` 而非盲目等待 `connect` 事件（复用的 socket 不触发 `connect`）

---

## 4. 新增：CA 证书透传（公司网络兼容）

- **文件**：`packages/mitmproxy/src/lib/proxy/common/util.js`
- **问题**：Electron 打包应用忽略 `NODE_EXTRA_CA_CERTS` 环境变量，公司 SASE/HTTPS 拦截设备的自签 CA 无法被信任，导致出站 HTTPS 握手失败
- **修复**：显式读取 `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` 指向的 PEM 文件，与 Node 内置根证书合并后传入 `https.Agent` 的 `ca` 选项

---

## 5. 新增：fadvise-linux 原生模块

- **路径**：`packages/fadvise-linux/`
- **作用**：调用 `posix_fadvise(FADV_DONTNEED)` 释放 SQLite 文件的内核页缓存
- **背景**：Xray 节点缓存 SQLite 达 650MB，订阅同步时页缓存累积导致 cgroup 内存峰值超 1GB
- **技术**：N-API 模块（`napi_register_module_v1`），ABI 稳定，无需按 Electron 版本重编译
- **效果**：cgroup 峰值从 1068MB 降至 554MB（文件缓存从 563MB 降至 29MB）

---

## 6. 新增：Linux 原生打包与 systemd 集成

### 打包脚本
- `packages/gui/pkg/before-pack.cjs` — 打包前准备
- `packages/gui/pkg/after-pack.cjs` — 打包后处理
- `packages/gui/pkg/linux/dev-sidecar.service` — systemd 服务单元（`MemoryHigh=280M`, `StartupMemoryHigh=300M`）
- `packages/gui/pkg/linux/postinst` / `prerm` — deb 安装/卸载脚本
- `packages/gui/pkg/deb-stop-processes.sh` — 升级前停止旧进程
- `packages/gui/scripts/download-xray.js` — 下载对应架构的 Xray 二进制
- `packages/gui/scripts/rebuild-core-native.js` — 用 Electron ABI 重建 better-sqlite3（系统 `npm rebuild` 会用系统 Node ABI 覆盖）
- `packages/gui/scripts/clean-native-artifacts.js` — 清理原生构建产物

### systemd 服务特性
- `MemoryHigh=280M` — 软限制，防止内存膨胀
- `StartupMemoryHigh=300M` — 启动期间临时放宽（冷启动页缓存峰值约 282MB）
- `Type=simple`，`Restart=on-failure`
- 升级时 `deb-stop-processes.sh` 先停止旧进程再安装

详见 [各平台安装说明.md](各平台安装说明.md)。

---

## 7. 新增：submit.sh 私有/公有分支分离

- **文件**：`submit.sh`（2600+ 行）
- **用途**：管理 fork 的私有（develop）和公有（master）分支分离提交
- **核心概念**：
  - **Private 分支**（develop）：包含 `.cline/` `.clinerules/` `.vscode/` 等本地配置，不推送到公有仓库
  - **Public 分支**（master）：只包含可公开的代码，推送到 GitHub origin
- **常用命令**：
  - `./submit.sh --new-dev-branch <feature> <base>` — 创建开发分支
  - `./submit.sh --check-prerequisites` — 检查提交前置条件
  - `./submit.sh --print-private-show` / `--print-public-show` — 预览各分支变更
  - `./submit.sh --commit-private` / `--commit-public` — 分别提交

---

## 8. 配置差异

### 远程配置 URL
- **上游**：`https://raw.githubusercontent.com/docmirror/dev-sidecar-config/...`
- **Fork**：`https://raw.giteeusercontent.com/wangliang181230/dev-sidecar-config/raw/main/...`（国内加速）

### overwall 插件
- **上游**：`enabled: true`（默认开启 PAC 翻墙）
- **Fork**：`enabled: false`（由 Xray 替代，避免双重代理）

### 油猴脚本 URL
- Fork 使用 gitee 镜像地址

---

## 9. 代理流量路由总结

```
客户端请求
  │
  ├─ 匹配 intercepts 规则?
  │   ├─ 是 → MITM 拦截管道（优先级顺序）:
  │   │        1. requestReplace (fork新增) — 改请求头/查询
  │   │        2. proxy — 转发到指定目标
  │   │           ├─ proxy: "tunnel://..." (fork新增) → 本地 Xray 隧道
  │   │           ├─ proxy: "proxy.cygn.eu.org" → Cygn Worker 反代
  │   │           └─ proxy: "其他域名" → HTTP 转发
  │   │        3. sni — SNI 伪装（如 github.com → baidu.com）
  │   │        4. abort — 中止请求
  │   │        5. redirect — 重定向
  │   │        6. cache — 缓存响应
  │   │
  │   └─ 否 → 直连目标服务器
  │
  └─ WebSocket 升级请求 (fork改造)
      └─ 走与 HTTP 相同的拦截管道（支持 proxy/sni/tunnel）
```

**关键**：Xray 隧道只在 `intercepts` 规则中 `proxy: "tunnel://..."` 时才使用。绝大多数域名（github.com, npm registry, docker hub 等）仍走 MITM + SNI 伪装 + 预设 IP + DNS 优化。

---

## 10. 与上游同步策略

- **上游**：`https://github.com/docmirror/dev-sidecar.git`（remote: `upstream`）
- **Fork 主仓库**：`https://github.com/atomlong/dev-sidecar.git`（remote: `origin`）
- **Fork 镜像**：`git@gitlab.com:atom.long/dev-sidecar.git`（remote: `gitlab`）
- **同步**：`git fetch upstream && git merge upstream/master`（通过 submit.sh 协调私有/公有分支）
- **分支约定**：
  - `develop` ↔ `master`（私有 ↔ 公有）
  - `dev/<name>` ↔ `feature/<name>`
  - `release-vX.Y.x` 用于发布自动化

详见 [提交工作流](../../submit.sh) 和 [Memory Bank](../../.github/memory-bank/)。
