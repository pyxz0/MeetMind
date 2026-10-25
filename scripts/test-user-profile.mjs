// 个人主页名片接口验证：共同会议统计、超管隐藏、隐私字段
const BASE = 'http://127.0.0.1:3000/api'
const stamp = Date.now().toString().slice(-8)
const PHONE_A = `135${stamp}`
const PHONE_B = `134${stamp}`
const PASSWORD = 'Passw0rd!'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed++
}

const call = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { data = null }
  return { status: res.status, data }
}

const run = async () => {
  await call('/auth/register', { method: 'POST', body: { phone: PHONE_A, password: PASSWORD, name: '名片甲' } })
  await call('/auth/register', { method: 'POST', body: { phone: PHONE_B, password: PASSWORD, name: '名片乙' } })

  const loginA = await call('/auth/login', { method: 'POST', body: { phone: PHONE_A, password: PASSWORD } })
  const loginB = await call('/auth/login', { method: 'POST', body: { phone: PHONE_B, password: PASSWORD } })
  const tokenA = loginA.data?.token
  const tokenB = loginB.data?.token
  const idA = loginA.data?.user?.id
  const idB = loginB.data?.user?.id
  const idSuper = 10

  // 甲建一场预约会议，乙是成员
  const created = await call('/meetings/scheduled', {
    method: 'POST', token: tokenA,
    body: {
      title: '名片验证会',
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      memberIds: [idB],
    },
  })
  check('甲创建预约会议', created.status === 201 || created.status === 200, `id=${created.data?.id}`)

  // 甲看乙的名片：应有 1 场共同会议
  const profB = await call(`/users/${idB}/profile`, { token: tokenA })
  check('甲看乙名片', profB.status === 200, `name=${profB.data?.name}`)
  check('共同会议=1', profB.data?.sharedMeetingCount === 1, `count=${profB.data?.sharedMeetingCount}`)
  check('共同会议列表非空', Array.isArray(profB.data?.sharedMeetings) && profB.data.sharedMeetings.length === 1)
  check('不返回邮箱', profB.data?.email === undefined)
  check('isSelf=false', profB.data?.isSelf === false)

  // 乙看甲：也是 1 场
  const profA = await call(`/users/${idA}/profile`, { token: tokenB })
  check('乙看甲名片', profA.status === 200 && profA.data?.sharedMeetingCount === 1, `count=${profA.data?.sharedMeetingCount}`)

  // 自己看自己：isSelf=true
  const self = await call(`/users/${idA}/profile`, { token: tokenA })
  check('自己看自己 isSelf=true', self.data?.isSelf === true)

  // 普通用户看超管：应 404（对外隐藏）
  const superProf = await call(`/users/${idSuper}/profile`, { token: tokenA })
  check('普通用户看超管名片 → 404', superProf.status === 404, `status=${superProf.status}`)

  console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((e) => { console.error(e); process.exit(1) })
