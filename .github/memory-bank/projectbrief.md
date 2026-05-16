# Project Brief: DevSidecar

DevSidecar (开发者边车) 是一款辅助开发者进行网络加速的工具，旨在解决国内开发者访问 GitHub、Stack Overflow、NPM 等资源速度慢或无法访问的问题。

## Core Features
- **GitHub 加速**: 通过修改 SNI 直连、IP 优选等方式加速 GitHub 访问、Clone、Release 下载。
- **DNS 优选**: 智能解析最佳 IP 地址，解决 DNS 污染问题。
- **请求拦截与代理**: 拦截特定请求并代理到加速镜像站点。
- **NPM 加速**: 支持 NPM 代理和 Registry 切换。
- **Stack Overflow 加速**: 代理静态资源 (ajax.google.com) 到国内 CDN。

## Architecture Overview
DevSidecar 采用 Monorepo 架构，包含以下核心模块：
- **Core**: 核心逻辑、配置管理、插件系统。
- **GUI**: 基于 Electron + Vue 的桌面应用界面。
- **Mitmproxy**: 自研/定制的中间人代理服务，负责流量拦截与修改。
- **CLI**: 命令行工具。

## Goals
- 提供稳定、快速的开发者网络环境。
- 简化代理配置，一键开启。
- 自动化处理系统代理、CA 证书安装等繁琐步骤。