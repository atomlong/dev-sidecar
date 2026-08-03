# Tech Context

## 技术栈

### 运行时
- **Node.js**: 22.x（CLI/core/mitmproxy），24.x（GUI Electron 41 内置）
- **Electron**: 41（fork 升级，上游仍为 19）
- **Python**: 3.11（原生模块编译需要，含 setuptools）
- **pnpm**: 9.13.2（workspace + shamefully-hoist=true）

### 语言与框架
- **core / mitmproxy / cli**: CommonJS（`.js`，无 `"type": "module"`）
- **gui**: ESM（`"type": "module"`）+ Vue 3 + Vue Router（hash）+ Ant Design Vue 4
- **fadvise-linux**: N-API C++ 原生模块（`napi_register_module_v1`，ABI 稳定）
- **ESLint**: `@antfu/eslint-config` flat config

### 关键依赖
- **MITM 代理**: `node-forge`（动态签发 per-domain 证书）、`tunnel-agent`（CONNECT 隧道）
- **DNS**: `dns-over-http`（DoH）、`lru-cache`（缓存）
- **Xray**: 内置 xray-core 二进制（按架构下载），VLESS/VMess/Trojan/SS/Reality
- **SQLite**: `better-sqlite3@13.0.1`（Xray 节点缓存）
- **系统代理**: `@starknt/sysproxy`（Win/Mac）、`gsettings`（Linux 桌面）
- **单实例互斥**: `proper-lockfile`（CLI/GUI 互斥，上游新增）
- **内存优化**: `@docmirror/fadvise-linux`（fork 新增，POSIX_FADV_DONTNEED 释放页缓存）

## 开发环境

### 构建
- **GUI 开发**: `cd packages/gui && npm run electron`（Vue dev server + Electron）
- **GUI 生产**: `npm run electron:build`（Vue build + electron-builder）
- **CLI**: `ds-cli`（SEA 打包，`packages/cli/scripts/build.js`）
- **原生模块**: C++20（Electron 41+ V8 13.x），`.npmrc` 设 `CXXFLAGS=-std=c++20`

### 测试
- **core**: `pnpm --filter @docmirror/dev-sidecar test`（Mocha + Chai，64 用例）
- **mitmproxy**: `pnpm --filter @docmirror/mitmproxy test`（1 用例）
- **cli**: `pnpm --filter @docmirror/dev-sidecar-cli test`（60+ 用例，上游新增）

### Lint
- `pnpm lint` / `pnpm lint:fix`

## 技术约束

### 模块系统差异
- root `package.json` 声明 `"type": "module"` 但只影响根级脚本
- core/mitmproxy/cli 用隐式 CommonJS
- gui 用 ESM
- 共享 JSON5 解析器：`@docmirror/mitmproxy/src/json`

### Electron 打包陷阱
- `vue.config.cjs` 设 `concatenateModules: false`（**必须**，否则 ant-design-vue Symbol provide/inject 崩溃）
- `better-sqlite3` 需按 Electron ABI 重建（`scripts/rebuild-core-native.js`）
- `NODE_EXTRA_CA_CERTS` 在 Electron 打包应用中被忽略 → fork 显式加载（`util.js` `loadExtraCaCerts`）

### 内存约束（Linux）
- systemd `MemoryHigh=280M` + `StartupMemoryHigh=300M`
- mitmproxy `--max-old-space-size=96`（写死）
- xray probe 进程隔离到 `dev-sidecar-xray-probe.scope`（不计入主 service）
- fadvise-linux 释放 SQLite 页缓存（650MB → 29MB file cache）

### 网络约束
- 远程配置 URL：`raw.giteeusercontent.com`（fork 改为 gitee 镜像，国内加速）
- CA 证书：`~/.dev-sidecar/dev-sidecar.ca.crt`（本地生成，首次运行）
- 用户配置：`~/.dev-sidecar/config.json`（diff 覆盖）
- 日志：`~/.dev-sidecar/logs/{core,gui,server}.log`（log4js）

## 工具使用
- **submit.sh**: 私有/公有分支分离提交（develop ↔ master）
- **openspec/**: 变更规格管理（xray-plugin、mitmproxy-tunnel）
- **.github/memory-bank/**: 跨会话记忆（本目录）
