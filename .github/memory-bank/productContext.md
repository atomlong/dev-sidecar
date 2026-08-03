# Product Context

## 为什么存在
中国开发者访问 GitHub、npm registry、Docker Hub 等境外开发资源时普遍存在速度慢、连接不稳定的问题。商业 VPN 不稳定且有合规风险，镜像源覆盖不全且更新延迟。DevSidecar 通过本地 MITM 代理提供零配置加速，按域名精细化路由。

## 解决的问题
1. **GitHub 慢**：clone/pull 超时、release 下载断流 → SNI 伪装 + 预设 IP + DNS 优选
2. **npm/Docker 慢**：registry 连接慢 → 走预设 IP / 镜像重定向
3. **严格封锁站点**（OpenAI/ChatGPT）→ Xray 隧道代理（fork 新增，可选）
4. **公司网络 SASE 拦截**：自签 CA 不被信任 → 显式加载 NODE_EXTRA_CA_CERTS（fork 修复）
5. **Linux 服务器无桌面**：gsettings 派生 dbus 进程浪费内存 → 桌面检测跳过（fork 修复）

## 用户体验目标
- **开箱即用**：安装 deb/exe 后一键开启，自动安装 CA 证书、设置系统代理
- **透明无感**：开发者无需改 git/npm/docker 配置，流量自动走代理
- **可选增强**：需要翻墙时显式启用 Xray 插件并配置订阅，不影响日常加速
- **低资源占用**：Linux systemd 内存软限制 280MB，适合后台常驻

## 工作方式
```
客户端（浏览器/git/npm/docker）
  └─ 系统代理 → 本地 MITM HTTPS 代理（31180/31181）
       ├─ 匹配 intercepts 规则?
       │   ├─ 是 → MITM 拦截管道：
       │   │        requestReplace → proxy → sni → abort → redirect → cache
       │   │        （proxy 支持 tunnel:// 走本地 Xray，fork 新增）
       │   └─ 否 → 直连目标
       └─ WebSocket 升级 → 走相同拦截管道（fork 改造）
```

## 目标用户
- 中国境内开发者（GitHub/npm/Docker 重度用户）
- 需要访问 OpenAI/ChatGPT 等严格封锁站点的开发者
- Linux 服务器用户（无桌面环境，需 systemd 集成）
- 公司网络环境开发者（SASE/HTTPS 拦截）
