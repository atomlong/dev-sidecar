// On non-Linux platforms, temporarily hide binding.gyp from fadvise-linux so
// electron-builder install-app-deps / node-gyp does not attempt to compile a
// Linux-only native module. On Linux this is a no-op.
const fs = require('node:fs')
const path = require('node:path')

if (process.platform === 'linux') {
  process.exit(0)
}

const bindingGyp = path.resolve(__dirname, '../../fadvise-linux/binding.gyp')
const hidden = `${bindingGyp}.hidden`

if (fs.existsSync(bindingGyp)) {
  fs.renameSync(bindingGyp, hidden)
  console.log(`[hide-fadvise-linux] renamed binding.gyp -> binding.gyp.hidden on ${process.platform}`)
} else if (fs.existsSync(hidden)) {
  console.log(`[hide-fadvise-linux] binding.gyp already hidden on ${process.platform}`)
} else {
  console.log(`[hide-fadvise-linux] binding.gyp not found, nothing to hide`)
}
