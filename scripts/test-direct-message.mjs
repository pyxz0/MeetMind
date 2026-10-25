// 私信功能端到端验证：注册两用户 → 发起会话 → 发文字/图片/文件 → 未读 → 已读
const BASE = 'http://127.0.0.1:3000/api'
const stamp = Date.now().toString().slice(-8)
const PHONE_A = `137${stamp}`
const PHONE_B = `136${stamp}`
const PASSWORD = 'Passw0rd!'

let failed = 0
const check = (name, ok, extra = '') => {
  const mark = ok ? '✓' : '✗'
  console.log(`${mark} ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed++
}

const call = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body
      ? body instanceof FormData ? body : JSON.stringify(body)
      : undefined,
  })
  let data = null
  try { data = await res.json() } catch { data = null }
  return { status: res.status, data }
}

const run = async () => {
  // 注册两个用户
  await call('/auth/register', { method: 'POST', body: { phone: PHONE_A, password: PASSWORD, name: '私信甲' } })
  await call('/auth/register', { method: 'POST', body: { phone: PHONE_B, password: PASSWORD, name: '私信乙' } })

  const loginA = await call('/auth/login', { method: 'POST', body: { phone: PHONE_A, password: PASSWORD } })
  const loginB = await call('/auth/login', { method: 'POST', body: { phone: PHONE_B, password: PASSWORD } })
  const tokenA = loginA.data?.token
  const tokenB = loginB.data?.token
  const idA = loginA.data?.user?.id
  const idB = loginB.data?.user?.id
  check('登录甲', !!tokenA)
  check('登录乙', !!tokenB)

  // 甲发起会话（需要知道乙的 id）
  const open = await call('/messages/conversations', { method: 'POST', token: tokenA, body: { peerId: idB } })
  check('甲发起会话', open.status === 200 || open.status === 201, `conversationId=${open.data?.conversationId}`)
  const convId = open.data?.conversationId

  // 甲发文字消息
  const send1 = await call(`/messages/conversations/${convId}/messages`, {
    method: 'POST', token: tokenA,
    body: new FormData() // 纯文字
  })
  // 纯文字需要 content 字段
  const formText = new FormData()
  formText.append('content', '你好，这是第一条私信')
  const sendText = await call(`/messages/conversations/${convId}/messages`, {
    method: 'POST', token: tokenA, body: formText,
  })
  check('甲发文字消息', sendText.status === 201, JSON.stringify(sendText.data))

  // 乙查看会话列表，应看到未读
  const listB = await call('/messages/conversations', { token: tokenB })
  const convB = listB.data?.find((c) => c.id === convId)
  check('乙看到会话且未读=1', convB && convB.unreadCount === 1, `unread=${convB?.unreadCount}`)

  // 乙拉取消息（应已读）
  const msgsB = await call(`/messages/conversations/${convId}/messages`, { token: tokenB })
  check('乙拉取到 1 条消息', msgsB.data?.length === 1, `count=${msgsB.data?.length}`)

  const listB2 = await call('/messages/conversations', { token: tokenB })
  const convB2 = listB2.data?.find((c) => c.id === convId)
  check('乙已读后未读=0', convB2 && convB2.unreadCount === 0, `unread=${convB2?.unreadCount}`)

  // 乙发图片消息（带一个假 png）
  const formImg = new FormData()
  formImg.append('kind', 'IMAGE')
  formImg.append('content', '一张图')
  formImg.append('file', new Blob(['fake-png-bytes'], { type: 'image/png' }), 'test.png')
  const sendImg = await call(`/messages/conversations/${convId}/messages`, {
    method: 'POST', token: tokenB, body: formImg,
  })
  check('乙发图片消息', sendImg.status === 201, `isImage=${sendImg.data?.attachments?.[0]?.isImage}`)

  // 甲未读总数应为 1
  const unreadA = await call('/messages/unread-total', { token: tokenA })
  check('甲未读总数=1', unreadA.data?.unreadTotal === 1, `total=${unreadA.data?.unreadTotal}`)

  console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error('执行异常：', e)
  process.exit(1)
})
