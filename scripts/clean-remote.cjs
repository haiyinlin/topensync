// 一次性：递归清掉远端验证目录，保证验证从干净状态开始
// 用法：MSYS_NO_PATHCONV=1 node scripts/clean-remote.cjs <远端目录>
//
// 注意：MSYS 会把命令行参数里的 `/qh/xxx` 转成 Windows 绝对路径，
// 所以必须带 MSYS_NO_PATHCONV=1，否则会对着一个不存在的路径操作。
const BASE = process.env.M0_BASE
const USER = process.env.M0_USER
const PASS = process.env.M0_PASS
const target = process.argv[2]

if (!BASE || !USER || !PASS || !target) {
  console.error('✗ 缺少 M0_BASE / M0_USER / M0_PASS 或目标目录')
  process.exit(1)
}
if (!/verify|demo/i.test(target)) {
  console.error(`✗ 拒绝清理非验证目录：${target}`)
  process.exit(1)
}

async function main() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  })
  const json = await res.json()
  const token = json.data.token
  const h = { Authorization: token, 'Content-Type': 'application/json' }

  const list = async (p) => {
    const r = await fetch(`${BASE}/api/fs/list`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ path: p, page: 1, per_page: 99999, refresh: true })
    })
    const j = await r.json()
    if (j.code !== 200) return null
    return j.data && j.data.content ? j.data.content : []
  }

  const remove = async (dir, names) => {
    if (!names.length) return
    const r = await fetch(`${BASE}/api/fs/remove`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ dir, names })
    })
    const j = await r.json()
    if (j.code !== 200) console.log(`  删除 ${dir} 失败:`, JSON.stringify(j).slice(0, 160))
  }

  const walk = async (p) => {
    const content = await list(p)
    if (content === null) return
    for (const item of content) {
      const child = `${p.replace(/\/+$/, '')}/${item.name}`
      if (item.is_dir) await walk(child)
    }
    await remove(p, content.map((x) => x.name))
  }

  await walk(target)
  /*
   * 上一步只删掉了目录**里的东西**，空目录本身还在。
   * OpenList 的 remove 是「按父目录 + 名字」删，所以要再删一次自己。
   */
  const base = target.replace(/\/+$/, '').slice(0, target.replace(/\/+$/, '').lastIndexOf('/'))
  const self = target.replace(/\/+$/, '').slice(target.replace(/\/+$/, '').lastIndexOf('/') + 1)
  if (base && self) await remove(base, [self])

  const after = await list(target)
  console.log(
    after === null
      ? '✓ 目录已删除'
      : `✓ 清理完成，剩余: ${after.map((x) => x.name).join(', ') || '(空)'}`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
