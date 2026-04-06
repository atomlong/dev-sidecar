# Progress

## Status
- **Current Version**: 2.1.2 (Released)
- **Development Branch**: `develop`
- **Stable Branch**: `master`

## Completed Features
- [x] **DevOps**: 
    - 自动化 Release Notes 生成 (Based on CHANGELOG)。
    - `submit.sh` 脚本优化（修复中文文件名支持）。
- [x] **Xray Plugin**: 
    - 内置打包 Xray Core 二进制文件与 `*.dat` 资源（自动下载构建），开箱即用，无需手动配置 `binPath`。
    - 集成 Xray Core，支持 VLESS, VMess, Trojan, ShadowSocks, Reality 等高级协议。
    - 支持订阅解析与自动更新。
    - 支持 `tunnel://` 透明代理转发。
    - 支持全局节点去重。
- [x] **Release v2.1.2**:
    - 同步升级各 package 版本至 2.1.2。
    - 更新 `CHANGELOG.md`，记录 `daily-cloudcode-pa.googleapis.com` 拦截崩溃修复。
    - 验证 `daily-cloudcode-pa.googleapis.com` 可正常拦截。
- [x] **Mitmproxy Robustness**:
    - 修复 `agent.options` 为空导致的拦截崩溃问题。
    - `sni`、`proxy`、`unVerifySsl`、普通请求与 Upgrade 请求路径已改为空值安全访问。
    - 已验证 `daily-cloudcode-pa.googleapis.com` 可正常拦截。
- [x] **Configuration**: 支持 HTTP/HTTPS/FILE 协议加载远程配置。
- [x] **Core Proxy**: HTTP/HTTPS 拦截与代理。
- [x] **DNS Optimization**: DNS 优选与智能解析。
- [x] **GitHub Acceleration**: SNI 伪装、Release 加速、Clone 加速。
- [x] **NPM Acceleration**: Registry 切换与代理。
- [x] **GUI**: Electron 桌面应用，支持配置与日志查看。
- [x] **System Integration**: 自动安装根证书 (Windows/Mac/Linux)，自动设置系统代理。

## Known Issues
- [ ] Windows 下关机/重启时若未退出应用，可能导致系统代理未还原（已在 1.8.9 修复，但需持续关注）。
- [ ] 部分 Linux 系统下系统代理设置可能不生效或需要 root 权限（目前仅支持 GNOME `gsettings`）。
- [ ] 与其他代理软件（如 Watt Toolkit、Clash）共存时可能存在端口冲突。

## Roadmap
- [ ] **v2.2.0**: 增强插件系统，支持更多自定义脚本。
- [ ] **UI/UX**: 优化设置界面交互，支持暗色模式（已部分支持）。
- [ ] **Platform**: 更好的 Linux 支持（Snap/Flatpak 打包）。