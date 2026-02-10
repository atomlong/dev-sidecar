const http = require('node:http')
const https = require('node:https')
const log = require('../../../utils/util.log.server')
const commonUtil = require('../common/util')
const RequestCounter = require('../../choice/RequestCounter')
const DnsUtil = require('../../dns')
const compatible = require('../compatible/compatible')
const dnsLookup = require('./dnsLookup')
const jsonApi = require('../../../json')

// create upgradeHandler function
module.exports = function createUpgradeHandler (createIntercepts, middlewares, externalProxy, dnsConfig, setting, compatibleConfig) {
  // return
  return function upgradeHandler (req, cltSocket, head, ssl) {
    let proxyReq

    const rOptions = commonUtil.getOptionsFromRequest(req, ssl, externalProxy, setting, compatibleConfig)
    const url = `${rOptions.method} ➜ ${rOptions.protocol}//${rOptions.hostname}:${rOptions.port}${rOptions.path}`

    const context = {
      rOptions,
      log,
      RequestCounter,
      setting,
    }
    let interceptors = createIntercepts(context)
    if (interceptors == null) {
      interceptors = []
    }
    const reqIncpts = interceptors.filter((item) => {
      return item.requestIntercept != null
    })

    // Mock response object for interceptors
    const res = {
      headers: {},
      setHeader (key, value) {
        this.headers[key] = value
      },
      getHeader (key) {
        return this.headers[key]
      },
      writeHead () {},
      write () {},
      end () {}
    }

    const requestInterceptorPromise = () => {
      return new Promise((resolve, reject) => {
        const next = () => {
          resolve()
        }
        try {
          if (reqIncpts && reqIncpts.length > 0) {
            for (const reqIncpt of reqIncpts) {
              if (!reqIncpt.requestIntercept) {
                continue
              }
              const goNext = reqIncpt.requestIntercept(context, req, res, ssl, next)
              if (goNext) {
                if (goNext !== 'no-next') {
                  next()
                }
                return
              }
            }
            next()
          } else {
            next()
          }
        } catch (e) {
          reject(e)
        }
      })
    }

    const proxyRequestPromise = async () => {
      rOptions.host = rOptions.hostname || rOptions.host || 'localhost'
      return new Promise((resolve, reject) => {
        // use the binded socket for NTLM
        if (rOptions.agent && rOptions.customSocketId != null && rOptions.agent.getName) {
          const socketName = rOptions.agent.getName(rOptions)
          const bindingSocket = rOptions.agent.sockets[socketName]
          if (bindingSocket && bindingSocket.length > 0) {
            bindingSocket[0].once('free', onFree)
            return
          }
        }
        onFree()

        function onFree () {
          const finalUrl = `${rOptions.method} ➜ ${rOptions.protocol}//${rOptions.hostname}:${rOptions.port}${rOptions.path}`
          log.info('发起代理Upgrade请求:', finalUrl, (rOptions.servername ? `, sni: ${rOptions.servername}` : ''), ', headers:', jsonApi.stringify2(rOptions.headers))

          const isDnsIntercept = {}
          if (dnsConfig && dnsConfig.dnsMap) {
            let dns = DnsUtil.hasDnsLookup(dnsConfig, rOptions.hostname)
            if (!dns && rOptions.servername) {
              dns = dnsConfig.dnsMap.ForSNI
              if (dns) {
                log.info(`域名 ${rOptions.hostname} 在dns中未配置，但使用了 sni: ${rOptions.servername}, 必须使用dns，现默认使用 '${dns.dnsName}' DNS.`)
              } else {
                log.warn(`域名 ${rOptions.hostname} 在dns中未配置，但使用了 sni: ${rOptions.servername}，且DNS服务管理中，也未指定SNI默认使用的DNS。`)
              }
            }
            if (dns) {
              rOptions.lookup = dnsLookup.createLookupFunc(res, dns, 'request url', finalUrl, rOptions.port, isDnsIntercept)
              log.debug(`域名 ${rOptions.hostname} DNS: ${dns.dnsName}`)
            } else {
              log.info(`域名 ${rOptions.hostname} 在DNS中未配置`)
            }
          }

          // 自动兼容程序：2
          if (rOptions.agent) {
            const compatibleConfig = compatible.getRequestCompatibleConfig(rOptions, rOptions.compatibleConfig)
            if (compatibleConfig && compatibleConfig.rejectUnauthorized != null && rOptions.agent.options.rejectUnauthorized !== compatibleConfig.rejectUnauthorized) {
              if (compatibleConfig.rejectUnauthorized === false && rOptions.agent.unVerifySslAgent) {
                log.info(`【自动兼容程序】${rOptions.hostname}:${rOptions.port}: 设置 'rOptions.agent.options.rejectUnauthorized = ${compatibleConfig.rejectUnauthorized}'`)
                rOptions.agent = rOptions.agent.unVerifySslAgent
              }
            }
          }

          proxyReq = (rOptions.protocol === 'https:' ? https : http).request(rOptions)
          
          proxyReq.on('error', (e) => {
            log.error('upgradeHandler proxyReq error:', e)
            // 自动兼容程序：2
            if (e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
              compatible.setRequestRejectUnauthorized(rOptions, false)
            }
            // Closes the socket if there is an error
            cltSocket.end()
          })

          proxyReq.on('response', (res) => {
            // if upgrade event isn't going to happen, close the socket
            if (!res.upgrade) {
              cltSocket.write(
                `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n` +
                `${Object.keys(res.headers).reduce((head, key) => {
                  const value = res.headers[key]
                  if (!Array.isArray(value)) {
                    head.push(`${key}: ${value}`)
                    return head
                  }
                  for (let i = 0; i < value.length; i++) {
                    head.push(`${key}: ${value[i]}`)
                  }
                  return head
                }, []).join('\r\n')}\r\n\r\n`
              )
              res.pipe(cltSocket)
            }
          })

          proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
            proxySocket.on('error', (e) => {
              log.error('upgrade error:', e)
            })

            cltSocket.on('error', (e) => {
              log.error('upgrade socket error:', e)
              proxySocket.end()
            })

            proxySocket.setTimeout(0)
            proxySocket.setNoDelay(true)
            proxySocket.setKeepAlive(true, 0)

            if (proxyHead && proxyHead.length) {
              proxySocket.unshift(proxyHead)
            }

            cltSocket.write(
              `${Object.keys(proxyRes.headers).reduce((head, key) => {
                const value = proxyRes.headers[key]
                if (!Array.isArray(value)) {
                  head.push(`${key}: ${value}`)
                  return head
                }
                for (let i = 0; i < value.length; i++) {
                  head.push(`${key}: ${value[i]}`)
                }
                return head
              }, ['HTTP/1.1 101 Switching Protocols']).join('\r\n')}\r\n\r\n`,
            )

            proxySocket.pipe(cltSocket).pipe(proxySocket)
            resolve()
          })
          
          proxyReq.end()
        }
      })
    }

    // workflow control
    (async () => {
      await requestInterceptorPromise()
      await proxyRequestPromise()
    })().catch((e) => {
      log.error(`Upgrade request error: ${url}, error:`, e)
      try {
        cltSocket.end()
      } catch (e) {
        // do nothing
      }
    })
  }
}