# Xray 插件使用说明

DevSideCar 内置了 **Xray 插件**及其核心引擎，开箱即用，用于支持自定义代理节点（VLESS, VMess, Trojan, Shadowsocks 等），帮助你更灵活地访问被墙资源。

> **注意**：本功能需要你自备可用的 Xray 节点或订阅链接。

---

## 1. 启用插件

1.  打开 DevSideCar 设置界面。
2.  找到 **插件配置 -> Xray**。
3.  勾选 **启用插件**。

---

## 2. 基础配置

### 本地端口 (`localPort`)
*   Xray 插件将在本地启动一个 HTTP 代理服务。默认端口为 **0**（自动选择可用端口），通常无需修改。
*   如果你需要指定端口（例如为了让其他程序也能使用），填入具体的端口号（如 `10809`）。

---

## 3. 添加节点

你可以通过以下两种方式添加代理节点：

### 方式一：订阅地址 (`subscriptions`)
如果你有机场或服务商提供的订阅链接，直接填入即可。DevSideCar 会自动解析其中的节点。
*   点击 **添加订阅**。
*   输入订阅 URL（通常以 `http` 或 `https` 开头）。

### 方式二：手动节点 (`nodes`)
如果你有单个节点的分享链接（如 `vless://...`, `vmess://...`），也可以手动添加。
*   点击 **添加节点**。
*   粘贴完整的分享链接。

---

## 4. 路由规则 (`rules`)

DevSideCar 会根据你配置的域名规则，将流量转发给 Xray 插件。

*   **域名 (`domain`)**: 需要走代理的域名，支持通配符。
    *   例如：`google.com`, `github.com`, `api.github.com`。
*   **策略 (`outboundTag` / `balancerTag`)**: 指定流量的去向。
    *   **自动选择 (推荐)**: 使用负载均衡器，自动选择最快的节点。
        *   配置字段: `"balancerTag": "balancer-proxy"`
    *   **指定节点**: 强制使用某个特定的出站节点。
        *   配置字段: `"outboundTag": "proxy_0"` (需要知道具体的节点 Tag)
        *   **注意**: 界面上暂不支持选择具体节点，需手动修改配置文件。
        *   **节点 Tag 命名规则**:
            *   Tag 格式为 `proxy_N`，其中 N 从 0 开始递增。
            *   排序顺序：**手动节点 (`nodes`)** 优先，然后按顺序追加 **订阅节点 (`subscriptions`)**。
            *   例如：你有 2 个手动节点，订阅A有 5 个节点。
                *   `proxy_0` ~ `proxy_1`: 手动节点
                *   `proxy_2` ~ `proxy_6`: 订阅A的节点
            *   **为什么不用节点自带的 Tag？**
                *   Xray 要求所有节点的 Tag 必须唯一。订阅链接中可能存在重名节点，使用自动生成的 `proxy_N` 可以确保 100% 唯一性，避免启动失败。
    *   **直连/阻断**:
        *   直连: `"outboundTag": "direct"`
        *   阻断: `"outboundTag": "block"`

> **注意**：由于当前版本 GUI 界面的限制，选择 "Proxy (Auto)" 时可能会错误地生成 `"outboundTag": "balancer-proxy"`。请手动修改配置文件 `~/.dev-sidecar/config.json`，将该规则的 `outboundTag` 改为 `balancerTag`，否则 Xray 可能会报错。

> **提示**：DevSideCar 默认已内置了一些常用加速域名的规则，通常只需在此处添加额外的自定义域名即可。

---

## 5. Sticky 锁定（保持出口 IP 不变）

某些场景（如 ChatGPT 注册）需要出口 IP 在一段时间内保持不变，否则会报 `ERR_NETWORK_CHANGED`。Xray 的 `leastPing` 策略默认每连接选最优节点，可能导致不同请求走不同出口 IP。

### 怎么用

在终端执行以下命令（需要 DS 正在运行且 Xray 插件已启动）：

**1. 查看当前 Xray API 端口**
```shell
cat ~/.dev-sidecar/running.json | jq '.app.status.plugin.xray.apiPort'
# 输出示例: 45457
```

**2. 锁定当前节点（保持出口 IP 不变）**
```shell
# 查看当前 balancer 选中的节点
xray api bi --server 127.0.0.1:$(cat ~/.dev-sidecar/running.json | jq -r '.app.status.plugin.xray.apiPort') balancer-proxy
# Selects 部分显示当前选中的 tag，例如 proxy_0

# 锁定到该节点（所有新连接都走这个节点）
xray api bo --server 127.0.0.1:$(cat ~/.dev-sidecar/running.json | jq -r '.app.status.plugin.xray.apiPort') -b balancer-proxy proxy_0
```

**3. 验证出口 IP 已固定**
```shell
# 多次请求，出口 IP 应该相同
curl -s -x http://127.0.0.1:10801 https://api.ipify.org
curl -s -x http://127.0.0.1:10801 https://api.ipify.org
# 两次输出应该相同
```

**4. 恢复动态选择（解除锁定）**
```shell
xray api bo --server 127.0.0.1:$(cat ~/.dev-sidecar/running.json | jq -r '.app.status.plugin.xray.apiPort') -b balancer-proxy -r
```

### 注意事项

- 锁定期间 observatory 继续探测节点（不影响），只是 balancer 选择被固定到指定节点
- 如果锁定节点被 Stage3 热刷新删除（延迟升高或探测失败），DS 会自动解除锁定
- DS 重启后锁定会自动失效（xray 进程重启后 balancer override 丢失）
- 锁定只影响**新连接**，已有连接继续走原节点完成
- 上述命令用 `jq -r` 自动提取 apiPort，无需手动替换

> **提示**：未来版本会在 GUI 中加入"锁定出口 IP"按钮，目前需通过上述命令行操作。

---

## 6. 常见问题

**Q: 节点无法连接？**
A: 
1. 确保你的节点本身是可用的（可以在其他客户端测试）。
2. 检查系统时间是否准确（Xray 对时间同步要求较高）。
3. 尝试更换一个端口，或者将 `localPort` 设为 `0` 让系统自动选择可用端口。

**Q: 如何查看日志？**
A: DevSideCar 的日志文件中会包含 Xray 插件的运行日志，如果遇到问题，可以查看日志以获取更多线索。

---