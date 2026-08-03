# Project Brief

## 项目定位
DevSidecar 是面向中国开发者的本地加速代理工具，通过运行本地 MITM HTTPS 代理、注入根 CA 证书、应用 DNS 优化 / SNI 伪装 / 请求拦截重定向规则，加速访问 GitHub、npm、Docker Hub 等境外站点。

## Fork 背景
本仓库 (`atomlong/dev-sidecar`) 是 [`docmirror/dev-sidecar`](https://github.com/docmirror/dev-sidecar) 的 Fork。Fork 在上游 MITM + SNI + 预设 IP + DNS 优化能力之上，新增了 **可选** 的 Xray 隧道代理插件（默认关闭），用于访问 OpenAI / ChatGPT 等严格封锁区域。

> **核心原则**：dev-sidecar 的代理**不是都走 Xray**。Xray 只是 fork 新增的可选插件之一，默认关闭。绝大多数流量仍走上游原有的 MITM 拦截 + SNI 伪装 + 预设 IP + DNS 优化机制。

## 核心目标
1. **加速**：GitHub clone/pull、npm install、Docker pull 等常见开发场景的访问速度
2. **兼容**：不破坏现有开发工作流，支持系统级代理、CA 证书信任、公司网络 SASE 拦截
3. **可选翻墙**：通过 Xray 插件为指定严格封锁域名提供加密隧道代理
4. **Linux 原生**：deb 打包 + systemd 集成 + 内存优化，适合服务器长期运行

## 范围边界
- **做**：本地 HTTPS 代理、DNS 优选、SNI 伪装、请求拦截重定向、CA 证书管理、Xray 隧道（可选）
- **不做**：全局 VPN、透明代理（需 iptables）、移动端、浏览器扩展

## 版本约定
- 当前版本：2.2.4
- 开发分支：`develop`（私有，含本地配置）
- 稳定分支：`master`（公有，推送到 GitHub origin）
- 镜像：GitLab `gitlab` remote
- 发布：tag `vX.Y.Z` 触发 GitHub Actions 构建 + Release

详见 [Fork版与上游区别.md](../../doc/wiki/Fork版与上游区别.md)。
