module.exports = function genConfig (port, nodes, rules, probeUrl, probeInterval) {
  const proxyTags = []
  const outbounds = []

  // Direct outbound
  outbounds.push({
    tag: 'direct',
    protocol: 'freedom',
    settings: {},
  })

  // Block outbound
  outbounds.push({
    tag: 'block',
    protocol: 'blackhole',
    settings: {
      response: {
        type: 'http',
      },
    },
  })

  // Proxy nodes
  nodes.forEach((node, index) => {
    // Generate a unique tag if not present
    const tag = `proxy_${index}`
    proxyTags.push(tag)
    
    // Clone node to avoid mutation issues
    const outbound = JSON.parse(JSON.stringify(node))
    outbound.tag = tag
    outbounds.push(outbound)
  })

  // Balancer
  const balancers = []
  if (proxyTags.length > 0) {
    balancers.push({
      tag: 'balancer-proxy',
      selector: proxyTags,
      strategy: {
        type: 'leastPing', // Uses observatory results
      },
    })
  }

  // Routing
  const routingRules = []
  
  // Custom rules from config
  if (rules && Array.isArray(rules)) {
    rules.forEach(rule => {
      if (rule.domain) {
        const domainList = Array.isArray(rule.domain) ? rule.domain : [rule.domain]
        const ruleConfig = {
          type: 'field',
          domain: domainList,
        }
        if (rule.balancerTag) {
          ruleConfig.balancerTag = rule.balancerTag
        } else if (rule.outboundTag) {
          ruleConfig.outboundTag = rule.outboundTag
        } else {
          // Default to balancer if no tag specified
          ruleConfig.balancerTag = 'balancer-proxy'
        }
        routingRules.push(ruleConfig)
      }
    })
  }
  
  // Default rule: If we have proxies, route everything else to direct?
  // Or route everything to balancer?
  // DevSideCar only sends traffic to Xray that matches its own rules (tunnel://).
  // So whatever hits Xray should probably go to the proxy (balancer).
  // But Xray also has "direct" outbound.
  // If DevSideCar sends google.com to Xray, it expects Xray to proxy it.
  // So the default fallback should be balancer-proxy.
  
  if (proxyTags.length > 0) {
    routingRules.push({
        type: 'field',
        network: 'tcp,udp',
        balancerTag: 'balancer-proxy'
    })
  }

  const routing = {
    domainStrategy: 'AsIs',
    balancers: balancers,
    rules: routingRules,
  }

  // Observatory
  const observatory = {
    subjectSelector: proxyTags, // Monitor all proxy nodes
    probeUrl: probeUrl || 'https://www.google.com/generate_204',
    probeInterval: `${probeInterval || 300}s`,
  }

  return {
    log: {
      loglevel: 'warning',
    },
    inbounds: [
      {
        tag: 'http-in', // Xray supports mixed inbound? Or separate? 
        // Xray's "socks" inbound doesn't support HTTP proxy.
        // We usually need "http" inbound or "dokodemo-door".
        // DevSideCar creates a tunnel. Tunnel connects to a TCP port.
        // If we use "socks", we need SOCKS5 handshake.
        // If we use "http", we need CONNECT.
        // tunnel-agent httpOverHttp sends CONNECT.
        // So we need an HTTP inbound? Or Socks?
        // mitmproxy's tunnel-agent can do either if configured.
        // My `util.getTunnelAgent` uses `httpOverHttp` (CONNECT) or `httpsOverHttp` (CONNECT).
        // Standard CONNECT implies HTTP proxy.
        // So I should use `protocol: 'http'` for the inbound?
        // Or `dokodemo-door`?
        // If I use `http` inbound, it accepts CONNECT.
        // Let's use `http`.
        // Wait, can Xray listen on the SAME port for both? No.
        // Unless I spawn two inbounds? But `port-finder` finds ONE port.
        // If I use `http` inbound, it works for CONNECT.
        
        // Wait, standard SOCKS5 is better for generic TCP tunneling.
        // But `tunnel-agent` creates HTTP tunnels (CONNECT).
        // So I should use `protocol: 'http'`.
        
        port: port, // Reuse port? Xray can't listen twice on same port.
        // I'll stick to 'http' protocol since we are sending HTTP CONNECT.
        listen: '127.0.0.1',
        protocol: 'http', 
        settings: {
           timeout: 0
        },
        sniffing: {
          enabled: true,
          destOverride: ['http', 'tls'],
        },
      }
    ],
    outbounds: outbounds,
    routing: routing,
    observatory: observatory,
  }
}