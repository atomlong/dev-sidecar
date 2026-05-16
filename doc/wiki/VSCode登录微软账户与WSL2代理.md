# VSCode登录微软账户与WSL2代理

## 场景

- Windows 本机没有安装 DevSidecar。
- DevSidecar 运行在 WSL2 中，Windows 通过可访问的 `http://localhost:31181` 使用该代理。
- VS Code 开启代理后，登录微软账户进行设置同步时失败；关闭代理后可正常登录。

## 现象

- 早期表现为 VS Code 内置样式的认证窗口报错，页面出现 `HTTP 404` 与 `login.microsoftonline.com`。
- 后续定位发现，问题并不等同于 `login.microsoftonline.com` 首页本身不可访问。
- 调整后，VS Code 登录会改为拉起外部浏览器，而不是原来的内置/原生认证对话流程。

## 根因说明

### 1. `proxy.excludeIpList` 和 `server.whiteList` 不是一层

- `proxy.excludeIpList` 的作用是把域名写入 **DevSidecar 所在系统** 的系统代理绕过列表。
- `server.whiteList` 的作用是：当请求已经到达 DevSidecar 的 `31181` 后，告诉 DevSidecar 对这些域名不做拦截，直接转发。

在“Windows 手动使用 WSL2 中的 DevSidecar 代理”这个场景下，Windows 并不会自动继承 WSL2 内部的系统代理绕过设置，因此不能只靠 `proxy.excludeIpList` 解决问题。

### 2. VS Code 的微软认证默认会优先走 Native Broker

- 在该场景下，VS Code 的微软认证扩展使用 Native Broker/WAM 流程时，更容易和代理环境冲突。
- 结果就是：认证流程卡在代理链路里，表现为 404、找不到代理、或者登录窗口异常。

## 已验证的修复方式

将 VS Code 的微软认证实现从默认 broker 流程切换为浏览器流程：

```json
{
  "microsoft-authentication.implementation": "msal-no-broker"
}
```

然后重载 VS Code。

## 修复成功的判据

- VS Code 登录微软账户时，会拉起外部浏览器。
- 浏览器里可以正常完成微软账户登录。
- 回到 VS Code 后，账户登录、设置同步或 Copilot 状态恢复正常。

## 补充建议

- 不要把问题简单理解为“给 `login.microsoftonline.com` 加白名单就行”。单独加这一条通常不是根因修复。
- 如果以后仍需让 Windows 客户端经由 WSL2 的 DevSidecar 访问某些微软认证域名，优先区分是需要：
  - 在客户端系统层面绕过代理。
  - 还是在 DevSidecar 服务层面通过 `server.whiteList` 直连转发。
