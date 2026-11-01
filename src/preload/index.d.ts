import { contextBridge } from 'electron'

declare global {
  interface Window {
    quarksync: import('./index').PreloadApi
  }
}

export {}
