module.exports = {
  enabled: false,
  name: 'Xray',
  tip: 'Xray 核心插件，支持 VLESS/VMess/Trojan 等高级协议',
  binPath: '',
  localPort: 10801, // 默认端口，0表示自动
  subscriptions: [], // 订阅地址列表
  nodes: [], // 手动节点列表
  rules: [], // 路由规则 [{domain: 'openai.com', outboundTag: 'proxy'}]
  probeUrl: 'https://www.google.com/generate_204',
  probeInterval: 300,
}