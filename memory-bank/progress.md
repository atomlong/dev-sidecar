# Progress

## Status
- **Current Version**: 2.0.1 (Released)
- **Development Branch**: `develop`
- **Stable Branch**: `master`

## Completed Features
- [x] **Xray Plugin**: 
    - 集成 Xray Core，支持 VLESS, VMess, Trojan, ShadowSocks, Reality 等高级协议。
    - 支持订阅解析与自动更新。
    - 支持 `tunnel://` 透明代理转发。
    - 支持全局节点去重。
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
- [ ] **v2.1.0**: 增强插件系统，支持更多自定义脚本。
- [ ] **UI/UX**: 优化设置界面交互，支持暗色模式（已部分支持）。
- [ ] **Platform**: 更好的 Linux 支持（Snap/Flatpak 打包）。