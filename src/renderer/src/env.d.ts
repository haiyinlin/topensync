/// <reference types="vite/client" />

/**
 * 静态资源模块声明。
 *
 * Vite 会把 `import logo from './logo.png'` 编译成资源 URL，
 * 但 TypeScript 不认识 .png 这类后缀，需要显式声明。
 * 单独写一份兜底，避免依赖 vite/client 是否被引用到。
 */
declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}
