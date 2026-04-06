module.exports = {
  name: 'unVerifySsl',
  priority: 124,
  requestIntercept (context, interceptOpt, req, res, ssl, next) {
    const { rOptions, log } = context

    const agentOptions = rOptions.agent && rOptions.agent.options ? rOptions.agent.options : {}
    if (agentOptions.rejectUnauthorized && rOptions.agent && rOptions.agent.unVerifySslAgent) {
      rOptions.agent = rOptions.agent.unVerifySslAgent
      log.info(`unVerifySsl intercept: ${rOptions.hostname}, unVerifySsl`)
      res.setHeader('DS-Interceptor', 'unVerifySsl')
    } else {
      log.info(`unVerifySsl intercept: ${rOptions.hostname}, already unVerifySsl`)
      res.setHeader('DS-Interceptor', 'already unVerifySsl')
    }

    return true
  },
  is (interceptOpt) {
    return interceptOpt.unVerifySsl === true || interceptOpt.ssl === false
  },
}
