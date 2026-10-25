// 待办状态修改权限验证：
//   该事项验收人 ✓ / 会议负责人 ✓ / 待办负责人本人 ✗ / 无关成员 ✗
const BASE = 'http://127.0.0.1:3000/api'
const stamp = Date.now().toString().slice(-8)
const PHONE = {
  leader: `133${stamp}`,
  assignee: `132${stamp}`,
  reviewer: `131${stamp}`,
  outsider: `130${stamp}`,
}
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
  const names = { leader: '权限甲', assignee: '权限乙', reviewer: '权限丙', outsider: '权限丁' }
  const tokens = {}
  const ids = {}

  for (const role of Object.keys(PHONE)) {
    await call('/auth/register', {
      method: 'POST',
      body: { phone: PHONE[role], password: PASSWORD, name: names[role] },
    })
    const login = await call('/auth/login', {
      method: 'POST',
      body: { phone: PHONE[role], password: PASSWORD },
    })
    tokens[role] = login.data?.token
    ids[role] = login.data?.user?.id
  }
  check('四个账号就绪', Object.values(tokens).every(Boolean))

  // 甲（负责人）建预约会议，把乙丙丁都加为成员
  const meeting = await call('/meetings/scheduled', {
    method: 'POST', token: tokens.leader,
    body: {
      title: '权限验证会',
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      memberIds: [ids.assignee, ids.reviewer, ids.outsider],
    },
  })
  const meetingId = meeting.data?.id
  check('创建会议', !!meetingId, `id=${meetingId}`)

  // 建一条待办：负责人=乙，验收人=丙
  const todo = await call(`/meetings/${meetingId}/todos`, {
    method: 'POST', token: tokens.leader,
    body: { content: '权限验证待办', assigneeUserId: ids.assignee, reviewerId: ids.reviewer },
  })
  const todoId = todo.data?.id
  check('创建待办（负责人=乙，验收人=丙）', !!todoId, `id=${todoId}`)

  const setStatus = (token, status) =>
    call(`/meetings/todos/${todoId}/status`, { method: 'PATCH', token, body: { status } })

  // 乙是待办负责人，但不是验收人：应被拒
  const byAssignee = await setStatus(tokens.assignee, 'IN_PROGRESS')
  check('待办负责人乙改状态 → 403', byAssignee.status === 403, `status=${byAssignee.status}`)

  // 丁是无关成员：应被拒
  const byOutsider = await setStatus(tokens.outsider, 'IN_PROGRESS')
  check('无关成员丁改状态 → 403', byOutsider.status === 403, `status=${byOutsider.status}`)

  // 丙是验收人：应通过
  const byReviewer = await setStatus(tokens.reviewer, 'IN_PROGRESS')
  check('验收人丙改状态 → 200', byReviewer.status === 200, `status=${byReviewer.status}`)

  // 甲是会议负责人：应通过
  const byLeader = await setStatus(tokens.leader, 'OPEN')
  check('会议负责人甲改状态 → 200', byLeader.status === 200, `status=${byLeader.status}`)

  // 有验收人也能直接勾「已完成」：验收人本人
  const reviewerComplete = await setStatus(tokens.reviewer, 'COMPLETED')
  check('验收人丙直接勾已完成 → 200', reviewerComplete.status === 200, `status=${reviewerComplete.status}`)

  // 退回进行中，再由会议负责人代完成
  await setStatus(tokens.leader, 'IN_PROGRESS')
  const leaderComplete = await setStatus(tokens.leader, 'COMPLETED')
  check('会议负责人甲代完成 → 200', leaderComplete.status === 200, `status=${leaderComplete.status}`)

  console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((e) => { console.error(e); process.exit(1) })
