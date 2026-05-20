const path = require('node:path')
const { defineConfig } = require('@vue/cli-service')
const webpack = require('webpack')
const electronBuilderConfig = require('./electron-builder.config.cjs')

const publishUrl = process.env.VUE_APP_PUBLISH_URL
if (publishUrl) {
  console.log('Publish url:', publishUrl)
}

module.exports = defineConfig({
  outputDir: 'dist',
  publicPath: './',
  pages: {
    index: {
      entry: 'src/main.js',
      title: 'DevSidecar-给开发者的边车辅助工具',
    },
  },
  lintOnSave: false,
  configureWebpack: {
    plugins: [
      new webpack.DefinePlugin({ 'global.GENTLY': true }),
    ],
    externals: {
      electron: 'commonjs electron',
    },
    resolve: {
      fallback: {
        path: require.resolve('path-browserify'),
        fs: false,
      },
    },
    module: {
      rules: [
        {
          test: /\.json5$/i,
          loader: 'json5-loader',
          options: {
            esModule: false,
          },
          type: 'javascript/auto',
        },
      ],
    },
  },
  pluginOptions: {
    electronBuilder: {
      mainProcessFile: './src/background.js',
      customFileProtocol: './',
      externals: [
        'better-sqlite3',
        'bindings',
        'file-uri-to-path',
        '@starknt/sysproxy',
        '@starknt/sysproxy-linux-x64-gnu',
        '@starknt/shutdown-handler-napi',
        '@starknt/shutdown-handler-napi-linux-x64-gnu',
      ],
      nodeIntegration: true,
      builderOptions: {
        ...electronBuilderConfig,
        files: ['**/*'],
      },
      chainWebpackMainProcess (config) {
        config.entry('mitmproxy').add(path.join(__dirname, 'src/bridge/mitmproxy.js'))
      },
    },
  },
})
