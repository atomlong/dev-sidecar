const fs = require('node:fs')
const path = require('node:path')
const archiver = require('archiver')
const pkg = require('../package.json')

function resolvePackageDir (packageName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, {
    paths: [path.join(__dirname, '..')],
  })
  return path.dirname(packageJsonPath)
}

function copyRuntimePackage (packageName, nodeModulesDir) {
  const sourceDir = resolvePackageDir(packageName)
  const targetDir = path.join(nodeModulesDir, ...packageName.split('/'))
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })

  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
  })

  sanitizeNativeHelperArtifacts(targetDir)
  console.log(`copied runtime package: ${packageName}`)
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
  copyRuntimePackage('@docmirror/fadvise-linux', unpackedNodeModulesDir)
  copyRuntimePackage('better-sqlite3', unpackedNodeModulesDir)
  copyRuntimePackage('bindings', unpackedNodeModulesDir)
  copyRuntimePackage('file-uri-to-path', unpackedNodeModulesDir)
}

function writeAppUpdateYmlForLinux (appOutDir) {
  const publishUrl = process.env.VUE_APP_PUBLISH_URL
  const publishProvider = process.env.VUE_APP_PUBLISH_PROVIDER
  // provider: generic
  // url: 'http://dev-sidecar.docmirror.cn/update/preview/'
  // updaterCacheDirName: '@docmirrordev-sidecar-gui-updater'
  const fileContent = `provider: ${publishProvider}
url: '${publishUrl}'
updaterCacheDirName: 'dev-sidecar-gui-updater'
`
  console.log('write linux app-update.yml,updateUrl:', publishUrl)
  const filePath = path.join(appOutDir, 'resources', 'app-update.yml')
  fs.writeFileSync(filePath, fileContent)
}
exports.default = async function (context) {
  let targetPath
  let systemType
  if (context.packager.platform.nodeName === 'darwin') {
    targetPath = path.join(context.appOutDir, `${context.packager.appInfo.productName}.app/Contents/Resources`)
    systemType = 'mac'
  } else if (context.packager.platform.nodeName === 'linux') {
    targetPath = path.join(context.appOutDir, './resources')
    systemType = 'linux'
    writeAppUpdateYmlForLinux(context.appOutDir)
  } else {
    targetPath = path.join(context.appOutDir, './resources')
    systemType = 'win'
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
    archive.directory(targetPath, false)
    archive.finalize()
  })
}
