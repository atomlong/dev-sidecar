module.exports = {
  name: 'sni',
  priority: 123,
  requestIntercept (context, interceptOpt, req, res, ssl, next) {
    const { rOptions, log } = context

    const agentOptions = rOptions.agent && rOptions.agent.options ? rOptions.agent.options : {}
    let unVerifySsl = agentOptions.rejectUnauthorized === false

    rOptions.servername = interceptOpt.sni
    if (!unVerifySsl && rOptions.protocol === 'https:') {
      // SNI 被改写后，目标站点证书通常不再匹配改写后的 servername。
      // 这里必须把当前请求切到不校验证书的路径，而不是依赖调用方“刚好”提供了兼容 agent。
      if (rOptions.agent && rOptions.agent.unVerifySslAgent) {
        rOptions.agent = rOptions.agent.unVerifySslAgent
      }
      rOptions.rejectUnauthorized = false
      unVerifySsl = true
    }

    const unVerifySslStr = unVerifySsl ? ', unVerifySsl' : ''
    res.setHeader('DS-Interceptor', `sni: ${interceptOpt.sni}${unVerifySslStr}`)

    log.info(`sni intercept: sni replace servername: ${rOptions.hostname} ➜ ${rOptions.servername}${unVerifySslStr}`)
    return true
  },
  is (interceptOpt) {
    return !!interceptOpt.sni && !interceptOpt.proxy // proxy生效时，sni不需要生效，因为proxy中也会使用sni覆盖 rOptions.servername
  },
}
