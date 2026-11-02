// 一次性：列出远端目录树（只读）
// 用法：MSYS_NO_PATHCONV=1 node scripts/remote-ls.cjs <远端路径>
const BASE = process.env.M0_BASE
const USER = process.env.M0_USER
const PASS = process.env.M0_PASS
const target = process.argv[2] || '/'

async function main() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  })
  const token = (await res.json()).data.token

  const list = async (p, refresh) => {
    const r = await fetch(`${BASE}/api/fs/list`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, page: 1, per_page: 99999, refresh })
    })
    return r.json()
  }

  const walk = async (p, indent = '') => {
    const j = await list(p, true)
    if (j.code !== 200) {
      console.log(`${indent}${p} → [${j.code}] ${j.message}`)
      return
    }
    for (const item of j.data.content || []) {
      console.log(`${indent}${item.is_dir ? '[D]' : '[F]'} ${p}/${item.name}  ${item.size}`)
      if (item.is_dir) await walk(`${p}/${item.name}`, indent + '  ')
    }
  }

  await walk(target)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
