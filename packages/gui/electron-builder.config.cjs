const { spawnSync } = require('node:child_process')

const publishUrl = process.env.VUE_APP_PUBLISH_URL
const publishProvider = process.env.VUE_APP_PUBLISH_PROVIDER

function hasExecutable (command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return !result.error && result.status === 0
}

const linuxTargets = [
  {
    target: 'deb',
    arch: ['x64', 'arm64', 'armv7l'],
  },
  {
    target: 'AppImage',
    arch: ['x64', 'arm64', 'armv7l'],
  },
  {
    target: 'tar.gz',
    arch: ['x64', 'arm64', 'armv7l'],
  },
]

const enableFlatpak = process.env.DEV_SIDECAR_ENABLE_FLATPAK === '1'

if (hasExecutable('rpmbuild')) {
  linuxTargets.push({
    target: 'rpm',
    arch: ['x64', 'arm64', 'armv7l'],
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
    'extra/**/*',
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
  ],
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
