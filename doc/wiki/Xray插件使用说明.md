# Xray 插件使用说明

DevSideCar 内置了 **Xray 插件**，用于支持自定义代理节点（VLESS, VMess, Trojan, Shadowsocks 等），帮助你更灵活地访问被墙资源。

> **注意**：本功能需要你自备可用的 Xray 节点或订阅链接。

---

## 1. 准备工作

### 下载 Xray-core
你需要先下载 Xray 的核心程序（Core），DevSideCar 仅负责调用它，并未内置该二进制文件。

1.  前往 [Xray-core Release](https://github.com/XTLS/Xray-core/releases) 页面。
2.  根据你的操作系统下载对应的版本：
    *   **Windows**: `Xray-windows-64.zip`
    *   **macOS (Intel)**: `Xray-macos-64.zip`
    *   **macOS (M1/M2)**: `Xray-macos-arm64-v8a.zip`
    *   **Linux**: `Xray-linux-64.zip`
3.  解压下载的文件，记住 `xray` (Linux/macOS) 或 `xray.exe` (Windows) 所在的路径。

---

## 2. 启用插件

1.  打开 DevSideCar 设置界面。
2.  找到 **插件配置 -> Xray**。
3.  勾选 **启用插件**。

---

## 3. 基础配置

### 核心路径 (`binPath`)
*   填入你在第 1 步解压得到的 `xray` 可执行文件的完整路径。
    *   **Windows 示例**: `D:\Tools\Xray\xray.exe`
    *   **macOS/Linux 示例**: `/usr/local/bin/xray`

### 本地端口 (`localPort`)
*   Xray 插件将在本地启动一个 HTTP 代理服务。默认端口为 **0**（自动选择可用端口），通常无需修改。
*   如果你需要指定端口（例如为了让其他程序也能使用），填入具体的端口号（如 `10809`）。

---

## 4. 添加节点

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

## 5. 路由规则 (`rules`)

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

## 6. 常见问题

**Q: 启动失败，提示 "Xray binary not found"？**
A: 请检查 **核心路径 (`binPath`)** 是否正确，路径中不要包含引号，且必须指向可执行文件本身（而不是文件夹）。

**Q: 节点无法连接？**
A: 
1. 确保你的节点本身是可用的（可以在其他客户端测试）。
2. 检查系统时间是否准确（Xray 对时间同步要求较高）。
3. 尝试更换一个端口，或者将 `localPort` 设置为 `0` 让系统自动选择。

**Q: 如何查看日志？**
A: DevSideCar 的日志文件中会包含 Xray 插件的运行日志，如果遇到问题，可以查看日志以获取更多线索。

---