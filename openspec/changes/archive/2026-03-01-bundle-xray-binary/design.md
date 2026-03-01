## Context

当前 DevSidecar 依赖 `xray` 作为高级协议代理核心，但是 `xray` 二进制文件并未随应用一起打包发布，导致用户必须额外运行外部安装脚本或者手动下载并配置 `binPath` 才能使用。这显著提高了用户的使用门槛。为了改善开箱即用的体验，我们决定将 `xray` 及其所依赖的 `geoip.dat`、`geosite.dat` 直接集成到应用安装包中。

## Goals / Non-Goals

**Goals:**
- 实现 Xray 二进制及其运行依赖数据库 (`geoip.dat`、`geosite.dat`) 的无感集成。
- 配置灵活的构建流程，确保不同系统平台（Win/Mac/Linux）和不同架构（x64/arm64 等）的安装包只包含对应版本的 `xray`，不因为打包所有平台而增加冗余体积。
- 在 `xray-plugin` 模块中增加基于资源目录的路径自动寻址功能。
- 提供自动化下载脚本，避免将大体积的二进制文件直接提交到代码仓库中。

**Non-Goals:**
- 修改 `xray` 的启动参数和核心代理逻辑。
- 替换或淘汰现有的自定义 Mitmproxy 拦截核心，Xray 依然作为可选插件。

## Decisions

### 1. 二进制文件获取与管理机制
由于 `xray` 二进制较大，直接放入 git 仓库会导致克隆极其缓慢。
- **方案**：编写一个 `scripts/download-xray.js` 脚本。在执行 `npm run electron:build` 之前或 `postinstall` 时调用，根据定义的版本号自动从 GitHub Releases 下载对应的 zip 包并解压到 `packages/gui/extra/xray/${os}/${arch}` 目录下，同时下载 `geoip.dat` 和 `geosite.dat` 放在 `packages/gui/extra/xray/` 根目录。
- 随后通过 `.gitignore` 忽略 `packages/gui/extra/xray` 目录。

### 2. Electron-builder 打包配置
在 `packages/gui/vue.config.js` 的 `extraResources` 配置中增加对 `xray` 文件的按需打包：
```javascript
extraResources: [
  {
    from: 'extra',
    to: 'extra',
    filter: ['**/*', '!xray/**'] // 原有的 extra 保持不变，但排除 xray 目录下的所有文件避免误拷贝
  },
  {
    from: 'extra/xray',
    to: 'extra/xray',
    filter: ['*.dat'] // 复制独立的 dat 数据文件
  },
  {
    from: 'extra/xray/${os}/${arch}',
    to: 'extra/xray' // 将特定平台的执行文件放入最终的 extra/xray 目录中
  }
]
```
这种设计使得打包后的 `xray` 执行文件与 `.dat` 数据库文件同处一个目录 (`resources/extra/xray`)，`xray` 在执行时能自动加载到数据库。

### 3. Xray 路径寻址 (`extra-path`)
在 `packages/core/src/shell/scripts/extra-path/index.js` 中新增 `getXrayExePath()`：
```javascript
function getXrayExePath () {
  const extraPath = getExtraPath()
  const exeName = process.platform === 'win32' ? 'xray.exe' : 'xray'
  return path.join(extraPath, 'xray', exeName)
}
```

### 4. 插件逻辑与界面调整
- **界面与配置项移除**：从 `packages/gui/src/view/plugin/Xray.vue` 中删除有关 `binPath` 的 `a-input` 组件和相关提示；并在 `packages/core/src/modules/plugin/xray/config.js` 中彻底移除 `binPath` 的默认值。
- **启动逻辑修改**：在 `packages/core/src/modules/plugin/xray/index.js` 中，不再尝试读取 `cfg.binPath`，而是强制使用内置路径：
```javascript
const binPath = extraPath.getXrayExePath()
if (!fs.existsSync(binPath)) {
  log.error('Xray 启动失败: 未找到内建的 Xray 可执行文件...')
  throw new Error('Xray binary not found')
}
```

## Risks / Trade-offs

- **[Risk] 安装包体积适度增加**
  - **Mitigation**: xray 核心一般约 20MB 左右，在按平台过滤打包后，单包体积仅增加约 20-30MB，对于桌面级应用处于可接受的范围。
- **[Risk] GitHub Releases 下载可能在没有代理的环境下失败**
  - **Mitigation**: 开发者在进行 Release 构建时，可以通过配置 CI/CD 环境或者使用国内的镜像加速源（如 fastgit/ghproxy 等）来确保 GitHub Releases 中的 Xray 能够稳定下载，毕竟这是在开发/打包阶段运行的脚本，而不是用户安装时运行。