import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 默认 5s 对「打真实 OpenList 实例」的契约测试太紧：
    // 单次上传 12MB 实测要 3~4 秒，夸克侧落盘还要再等 1~2 秒。
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
