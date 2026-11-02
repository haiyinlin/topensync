/**
 * 由 PNG 生成 Windows .ico。
 *
 * 为什么不用现成工具：项目不想为一个图标引入图像处理依赖。
 * 用 Electron 自带的 `nativeImage` 缩放（它在 devDependencies 里，打包时不需要），
 * 再按 ICO 容器格式拼装。
 *
 * ICO 容器允许内嵌 PNG（Vista 起支持），所以不需要 BMP 编码。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/make-ico.cjs
 */
const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const SIZES = [16, 24, 32, 48, 64, 128, 256]

/** 组装 ICO：6 字节头 + 每帧 16 字节目录项 + 各帧 PNG 数据 */
function buildIco(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: 1 = icon
  header.writeUInt16LE(frames.length, 4)

  const dir = Buffer.alloc(16 * frames.length)
  let offset = 6 + 16 * frames.length
  frames.forEach((f, i) => {
    const o = i * 16
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, o) // 宽（0 表示 256）
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, o + 1) // 高
    dir.writeUInt8(0, o + 2) // 调色板数
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // color planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(f.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += f.data.length
  })

  return Buffer.concat([header, dir, ...frames.map((f) => f.data)])
}

app.whenReady().then(() => {
  const root = path.resolve(__dirname, '..')
  const src = path.join(root, 'resources', 'icon.png')
  const out = path.join(root, 'resources', 'icon.ico')

  const image = nativeImage.createFromPath(src)
  if (image.isEmpty()) {
    console.error('图标读取失败：' + src)
    app.exit(1)
    return
  }

  const frames = SIZES.map((size) => {
    const resized = image.resize({ width: size, height: size, quality: 'best' })
    return { size, data: resized.toPNG() }
  })

  fs.writeFileSync(out, buildIco(frames))
  console.log(
    `已生成 ${out}\n  帧：${SIZES.join(', ')}\n  大小：${fs.statSync(out).size} 字节`
  )
  app.exit(0)
})
