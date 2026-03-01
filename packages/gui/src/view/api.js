import { ipcRenderer, shell } from 'electron'
import lodash from 'lodash'

let inited = false
let apiObj = null
export function apiInit (app) {
  const invoke = (api, args) => {
    return ipcRenderer.invoke('apiInvoke', [api, args]).catch((e) => {
      app.$notification.error({
        message: 'Api invoke error',
        description: e.message,
      })
    })
  }
  const send = (channel, message) => {
    console.log('ipcRenderer.send, channel=', channel, ', message=', message)
    return ipcRenderer.send(channel, message)
  }

  apiObj = {
    ipc: {
      on (channel, callback) {
        ipcRenderer.on(channel, callback)
      },
      removeAllListeners (channel) {
        ipcRenderer.removeAllListeners(channel)
      },
      invoke,
      postMessage (channel, ...args) {
        ipcRenderer.postMessage(channel, ...args)
      },
      send,
      async openExternal (href) {
        await shell.openExternal(href)
      },
      openPath (file) {
        // Can't use node:path here directly in frontend without polyfill
        // We just invoke backend IPC for openPath or do naive replace
        // Usually file here is already resolved by vue components?
        // Wait, openPath shouldn't use node:path if webpack 5 doesn't polyfill it
        // Or we use another IPC channel to open path.
        // Actually, the vue components probably just send the raw path and open it.
        // If we just use shell.openPath(file) it might work since the backend path is absolute.
        shell.openPath(file)
      },
    },
  }

  const bindApi = (api, param1) => {
    lodash.set(apiObj, api, (param2) => {
      return invoke(api, param2 || param1)
    })
  }

  if (!inited) {
    return invoke('getApiList').then((list) => {
      inited = true
      for (const item of list) {
        bindApi(item)
      }
      console.log('api inited:', apiObj)
      return apiObj
    })
  }

  return new Promise((resolve) => {
    resolve(apiObj)
  })
}
export function useApi () {
  return apiObj
}
