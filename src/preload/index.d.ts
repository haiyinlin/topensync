import { contextBridge } from 'electron'

declare global {
  interface Window {
    topensync: import('./index').PreloadApi
  }
}

export {}
