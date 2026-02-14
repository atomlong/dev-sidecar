const net = require('net')

module.exports = {
  findFreePort: async () => {
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      server.on('error', reject)
      server.listen(0, () => {
        const port = server.address().port
        server.close(() => {
          resolve(port)
        })
      })
    })
  },
  isPortAvailable: async (port) => {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.unref()
      server.on('error', () => {
        resolve(false)
      })
      server.listen(port, () => {
        server.close(() => {
          resolve(true)
        })
      })
    })
  },
}