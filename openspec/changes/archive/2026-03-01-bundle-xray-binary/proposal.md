## Why

当前 dev-sidecar 的 xray 插件依赖于用户自行下载 xray 核心程序，或者通过外部安装脚本将其下载到系统目录中，并在界面配置 `binPath` 后才能使用。这增加了新用户的学习成本和安装步骤。通过将 xray 核心程序（包括运行必须的数据库文件）直接集成到 dev-sidecar 的安装包中，可以实现真正的“开箱即用”，大幅提升用户体验。

## What Changes

- 在打包资源目录（如 `extra/xray/`）中引入不同平台和架构对应的 xray 核心二进制文件（`xray.exe` / `xray` 等），以及其依赖的 `geoip.dat` 和 `geosite.dat` 路由数据库。
- 修改 `packages/gui/vue.config.js` 的打包配置，利用 `electron-builder` 提供的环境变量参数（如 `${os}` 和 `${arch}`），在构建各平台安装包时仅包含对应平台的 xray 二进制文件，避免包体积臃肿。
- 在 `extra-path` 工具中新增对内置 xray 路径的解析逻辑，并在启动 xray 进程时强制使用内建的执行文件。
- 完全废弃并移除 `binPath` 配置项及其在前端界面的输入框。

## Capabilities

### New Capabilities

### Modified Capabilities

- `xray-plugin`: 增强插件逻辑，使其支持加载随应用一起打包的预编译 Xray 二进制以及必要的 .dat 配置文件。彻底移除配置文件和界面中的 `binPath` 选项。

## Impact

- `packages/gui/vue.config.js`: 将增加对 xray 文件的打包指令。
- `packages/core/src/shell/scripts/extra-path/index.js`: 需要暴露获取 xray 内建可执行文件的函数。
- `packages/core/src/modules/plugin/xray/index.js`: 启动 xray 的逻辑发生变更，兼容无 `binPath` 配置的情况。
- 项目的部署/构建流程中可能需要增加一条预处理脚本（如 `postinstall`）用于从网络拉取 xray 核心文件，避免直接向 Git 仓库提交巨大的二进制文件。