const { spawnSync } = require('node:child_process')
const path = require('node:path')

const publishUrl = process.env.VUE_APP_PUBLISH_URL
const publishProvider = process.env.VUE_APP_PUBLISH_PROVIDER
const debLifecycleScript = path.join(__dirname, 'pkg', 'deb-stop-processes.sh')
const debPostinstScript = path.join(__dirname, 'pkg', 'linux', 'postinst')
const debPrermScript = path.join(__dirname, 'pkg', 'linux', 'prerm')

function normalizeArch (arch) {
  if (arch === 'x64' || arch === 'arm64' || arch === 'armv7l') {
    return arch
  }
  return null
}

function resolveLinuxTargetArchs () {
  const explicitArchs = (process.env.DEV_SIDECAR_LINUX_TARGET_ARCHES || '')
    .split(',')
    .map(item => normalizeArch(item.trim()))
    .filter(Boolean)

  if (explicitArchs.length > 0) {
    return explicitArchs
  }

  const nativeArch = normalizeArch(process.arch)
  if (nativeArch) {
    return [nativeArch]
  }

  return ['x64']
}

const linuxTargetArchs = resolveLinuxTargetArchs()

function hasExecutable (command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return !result.error && result.status === 0
}

const linuxTargets = [
  {
    target: 'deb',
    arch: linuxTargetArchs,
  },
  {
    target: 'AppImage',
    arch: linuxTargetArchs,
  },
  {
    target: 'tar.gz',
    arch: linuxTargetArchs,
  },
]

const enableFlatpak = process.env.DEV_SIDECAR_ENABLE_FLATPAK === '1'

if (hasExecutable('rpmbuild')) {
  linuxTargets.push({
    target: 'rpm',
    arch: linuxTargetArchs,
  })
}

if (enableFlatpak && hasExecutable('flatpak') && hasExecutable('flatpak-builder')) {
  linuxTargets.push({
    target: 'flatpak',
    arch: ['x64'],
  })
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev-sidecar',
  productName: 'dev-sidecar',
  artifactName: 'DevSidecar-${version}-${arch}.${ext}',
  asarUnpack: [
    '**/node_modules/better-sqlite3/**/*',
    '!**/node_modules/better-sqlite3/build/node_gyp_bins{,/**/*}',
  ],
  copyright: 'Copyright © 2020-' + new Date().getFullYear() + ' Greper, WangLiang, CuteOmega',
  directories: {
    output: 'dist_electron',
    buildResources: 'build',
  },
  files: [
    {
      from: 'dist',
      to: 'dist',
      filter: [
        '**/*',
        '!win-*/**/*',
        '!mac-*/**/*',
        '!linux-*/**/*',
        '!*.zip',
        '!*.dmg',
        '!*.blockmap',
        '!*.exe',
        '!*.AppImage',
        '!*.deb',
        '!*.rpm',
        '!*.tar.gz',
        '!*.flatpak',
        '!builder-*.yml',
        '!builder-*.yaml',
      ],
    },
    'src/**/*',
    'package.json',
  ],
  extraResources: [
    {
      from: 'extra',
      to: 'extra',
      filter: [
        '**/*',
        '!xray/**',
      ],
    },
    {
      from: 'extra/xray',
      to: 'extra/xray',
      filter: [
        '*.mmdb',
        'geoip.dat',
        'geosite.dat',
      ],
    },
    {
      // eslint-disable-next-line no-template-curly-in-string
      from: 'extra/xray/${os}/${arch}',
      to: 'extra/xray',
    },
    {
      from: 'pkg/linux',
      to: 'linux',
      filter: [
        'dev-sidecar.service',
      ],
    },
  ],
  beforePack: './pkg/before-pack.cjs',
  afterPack: './pkg/after-pack.cjs',
  afterAllArtifactBuild: './pkg/after-all-artifact-build.cjs',
  nsis: {
    oneClick: false,
    perMachine: true,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
  },
  win: {
    icon: 'build/icons/',
    target: [
      {
        target: 'nsis',
        arch: ['x64', 'ia32', 'arm64'],
      },
    ],
  },
  linux: {
    icon: 'build/mac/',
    target: linuxTargets,
    appId: 'cn.docmirror.DevSidecar',
    category: 'System',
  },
  deb: {
    fpm: [
      `--before-install=${debLifecycleScript}`,
      `--before-remove=${debLifecycleScript}`,
      `--after-install=${debPostinstScript}`,
      `--after-remove=${debPrermScript}`,
    ],
  },
  mac: {
    icon: './build/mac/icon.icns',
    target: {
      target: 'dmg',
      arch: ['x64', 'arm64'],
    },
    category: 'public.app-category.developer-tools',
  },
  publish: publishProvider
    ? {
        provider: publishProvider,
        url: publishUrl,
      }
    : undefined,
}
