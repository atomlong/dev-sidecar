## 1. 准备工作：Xray 核心文件下载脚本

- [x] 1.1 在项目中新建 `scripts/download-xray.js` 脚本
- [x] 1.2 编写脚本：从 GitHub Releases 等源下载各平台 (win-x64, mac-x64, mac-arm64, linux-x64 等) 的 Xray 二进制文件，解压到 `packages/gui/extra/xray/${os}/${arch}`
- [x] 1.3 编写脚本：下载 `geoip.dat` 和 `geosite.dat` 到 `packages/gui/extra/xray/` 目录下
- [x] 1.4 在 `packages/gui/package.json` 添加 npm script 触发该下载脚本，并更新 `.gitignore` 忽略 `packages/gui/extra/xray`

## 2. Electron-builder 打包配置更新

- [x] 2.1 修改 `packages/gui/vue.config.js`
- [x] 2.2 调整 `extraResources` 配置，按平台和架构条件 (`${os}/${arch}`) 将 xray 二进制和 `.dat` 数据文件打包进 `resources/extra/xray` 目录中

## 3. Xray Plugin 核心代码改造与界面清理

- [x] 3.1 修改 `packages/core/src/shell/scripts/extra-path/index.js`，增加 `getXrayExePath` 方法，指向内建二进制路径
- [x] 3.2 删除 `packages/gui/src/view/plugin/Xray.vue` 中涉及 `binPath` 的所有前端组件代码及变量。
- [x] 3.3 删除 `packages/core/src/modules/plugin/xray/config.js` 中的 `binPath` 配置项。
- [x] 3.4 修改 `packages/core/src/modules/plugin/xray/index.js`，启动 xray 时直接调用 `getXrayExePath()`，彻底移除对配置对象 `binPath` 的判断。
- [x] 3.5 确保在启动 xray 进程或在工作目录中能正确找到数据库文件 `geoip.dat` 和 `geosite.dat`。

## 4. 测试与验证

- [x] 4.1 运行测试，验证 Xray 能否在不配置 `binPath` 的情况下成功启动
- [x] 4.2 验证应用是否正常拦截流量并通过内置 Xray 代理
