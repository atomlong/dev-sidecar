const fs = require('node:fs')
const path = require('node:path')
const archiver = require('archiver')
const pkg = require('../package.json')
const { copyRuntimePackage } = require('../scripts/clean-native-artifacts')

function resolvePackageDir (packageName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, {
    paths: [path.join(__dirname, '..')],
  })
  return path.dirname(packageJsonPath)
}

function sanitizeNativeHelperArtifacts (packageDir) {
  const nodeGypBinsDir = path.join(packageDir, 'build', 'node_gyp_bins')
  fs.mkdirSync(nodeGypBinsDir, { recursive: true })

  for (const entry of fs.readdirSync(nodeGypBinsDir)) {
    const helperPath = path.join(nodeGypBinsDir, entry)
    writeNativeHelperStub(helperPath)
  }

  writeNativeHelperStub(path.join(nodeGypBinsDir, 'python3'))
  writeNativeHelperStub(path.join(nodeGypBinsDir, 'python3.10'))
  console.log(`sanitized native helper artifacts: ${nodeGypBinsDir}`)
}

function writeNativeHelperStub (helperPath) {
  fs.rmSync(helperPath, { recursive: true, force: true })
  fs.writeFileSync(helperPath, '#!/usr/bin/env sh\necho "node-gyp helper is not available in packaged runtime" >&2\nexit 1\n')
  fs.chmodSync(helperPath, 0o755)
}

function ensureNativeRuntimeDependencies (resourcesDir) {
  const unpackedNodeModulesDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules')
  fs.mkdirSync(unpackedNodeModulesDir, { recursive: true })
  sanitizeNativeHelperArtifacts(copyRuntimePackage('@docmirror/fadvise-linux', unpackedNodeModulesDir, {
    sourceDir: path.resolve(__dirname, '../../fadvise-linux'),
  }))
  sanitizeNativeHelperArtifacts(copyRuntimePackage('better-sqlite3', unpackedNodeModulesDir, {
    sourceDir: resolvePackageDir('better-sqlite3'),
  }))
  copyRuntimePackage('bindings', unpackedNodeModulesDir, {
    sourceDir: resolvePackageDir('bindings'),
  })
  copyRuntimePackage('file-uri-to-path', unpackedNodeModulesDir, {
    sourceDir: resolvePackageDir('file-uri-to-path'),
  })
}

/**
 * 删除 Electron 自带的语言包，只保留中文和英文
 * 可减少约 15-20MB
 */
function pruneLocales (resourcesDir, platform) {
  let localesDir
  if (platform === 'mac') {
    // macOS: Contents/Resources/locales/
    localesDir = path.join(resourcesDir, 'locales')
  } else {
    // Windows/Linux: resources/app.asar.unpacked 的 locales 可能在 framework 中
    // Electron 的 locales 通常在 app 同级目录
    localesDir = path.join(path.dirname(resourcesDir), 'locales')
  }

  if (!fs.existsSync(localesDir)) {
    // try alternative: inside resources
    localesDir = path.join(resourcesDir, 'locales')
    if (!fs.existsSync(localesDir)) {
      console.log('locales dir not found at:', localesDir)
      return
    }
  }

  const keep = new Set(['zh-CN.pak'])
  const files = fs.readdirSync(localesDir)
  let removed = 0
  let savedBytes = 0
  for (const file of files) {
    if (keep.has(file)) continue
    const filePath = path.join(localesDir, file)
    const stat = fs.statSync(filePath)
    savedBytes += stat.size
    fs.unlinkSync(filePath)
    removed++
  }
  console.log(`Removed ${removed} unused locale files, saved ${(savedBytes / 1024 / 1024).toFixed(1)} MB`)
}

function writeAppUpdateYmlForLinux (appOutDir) {
  const publishUrl = process.env.VUE_APP_PUBLISH_URL
  const publishProvider = process.env.VUE_APP_PUBLISH_PROVIDER
  if (!publishUrl || !publishProvider) return
  const fileContent = `provider: ${publishProvider}
url: '${publishUrl}'
updaterCacheDirName: 'dev-sidecar-gui-updater'
`
  console.log('write linux app-update.yml, updateUrl:', publishUrl)
  const filePath = path.join(appOutDir, 'resources', 'app-update.yml')
  fs.writeFileSync(filePath, fileContent)
}

exports.default = async function (context) {
  let resourcesDir
  let platform

  if (context.packager.platform.nodeName === 'darwin') {
    resourcesDir = path.join(context.appOutDir, `${context.packager.appInfo.productName}.app/Contents/Resources`)
    platform = 'mac'
  } else if (context.packager.platform.nodeName === 'linux') {
    resourcesDir = path.join(context.appOutDir, './resources')
    platform = 'linux'
    writeAppUpdateYmlForLinux(context.appOutDir)
  } else {
    resourcesDir = path.join(context.appOutDir, './resources')
    platform = 'win'
  }
  ensureNativeRuntimeDependencies(targetPath)
  const partUpdateFile = `update-${systemType}-${pkg.version}.zip`
  const outputPath = path.join(context.outDir, partUpdateFile)

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', () => {
      console.log(`Created ${partUpdateFile}, size: ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`)
      resolve()
    })

    archive.on('error', (err) => {
      reject(err)
    })

    archive.pipe(output)
    archive.directory(resourcesDir, false)
    archive.finalize()
  })
}
