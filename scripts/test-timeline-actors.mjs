// 记录页数据验证：谁撤回 / 谁通过 / 谁改了会议状态
const BASE = 'http://127.0.0.1:3000/api'
const stamp = Date.now().toString().slice(-8)
const PHONE = {
  leader: `139${stamp}`,
  assignee: `138${stamp}`,
  reviewer: `136${stamp}`,
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
  const names = { leader: '记录甲', assignee: '记录乙', reviewer: '记录丙' }
  const tokens = {}
  const ids = {}

  for (const role of Object.keys(PHONE)) {
    await call('/auth/register', { method: 'POST', body: { phone: PHONE[role], password: PASSWORD, name: names[role] } })
    const login = await call('/auth/login', { method: 'POST', body: { phone: PHONE[role], password: PASSWORD } })
    tokens[role] = login.data?.token
    ids[role] = login.data?.user?.id
  }

  const meeting = await call('/meetings/scheduled', {
    method: 'POST', token: tokens.leader,
    body: {
      title: '记录验证会',
      scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      memberIds: [ids.assignee, ids.reviewer],
    },
  })
  const meetingId = meeting.data?.id

  const todo = await call(`/meetings/${meetingId}/todos`, {
    method: 'POST', token: tokens.leader,
    body: { content: '记录验证待办', assigneeUserId: ids.assignee, reviewerId: ids.reviewer },
  })
  const todoId = todo.data?.id
  check('会议与待办就绪', !!meetingId && !!todoId)

  // 乙提交 → 乙撤回（验证「谁撤回的」）
  const sub1 = await call(`/meetings/todos/${todoId}/submissions`, {
    method: 'POST', token: tokens.assignee, body: { note: '第一次交付' },
  })
  await call(`/meetings/submissions/${sub1.data?.id}/withdraw`, { method: 'POST', token: tokens.assignee })
  check('乙提交并撤回', true)

  // 乙再提交 → 丙通过（验证「谁通过的」）
  const sub2 = await call(`/meetings/todos/${todoId}/submissions`, {
    method: 'POST', token: tokens.assignee, body: { note: '第二次交付' },
  })
  const accept = await call(`/meetings/submissions/${sub2.data?.id}/accept`, { method: 'POST', token: tokens.reviewer })
  check('丙验收通过', accept.status === 200 || accept.status === 201, `status=${accept.status}`)

  // 甲改会议状态（验证「谁修改的会议状态」）
  const statusChange = await call(`/meetings/${meetingId}/completion-status`, {
    method: 'PATCH', token: tokens.leader, body: { completionStatus: 'CANCELLED' },
  })
  check('甲修改会议状态', statusChange.status === 200, `status=${statusChange.status}`)

  // 读待办事件
  const events = await call(`/meetings/todos/${todoId}/events`, { token: tokens.leader })
  const types = (events.data ?? []).map((e) => e.type)
  check('待办事件含 withdrawn', types.includes('withdrawn'))
  check('待办事件含 accepted', types.includes('accepted'))

  const withdrawn = (events.data ?? []).find((e) => e.type === 'withdrawn')
  check('撤回事件带操作人', withdrawn?.actor?.name === '记录乙', `actor=${withdrawn?.actor?.name}`)

  const accepted = (events.data ?? []).find((e) => e.type === 'accepted')
  check('通过事件带操作人', accepted?.actor?.name === '记录丙', `actor=${accepted?.actor?.name}`)
  check('通过事件关联提交', !!accepted?.submissionId)

  // 读会议事件
  const meetingEvents = await call(`/meetings/${meetingId}/events`, { token: tokens.assignee })
  const changed = (meetingEvents.data ?? []).find((e) => e.type === 'status_changed')
  check('会议状态事件存在', !!changed, `count=${meetingEvents.data?.length}`)
  check('会议状态事件带操作人', changed?.actor?.name === '记录甲', `actor=${changed?.actor?.name}`)
  check('会议状态事件含前后值', changed?.fromStatus === 'COMPLETED' && changed?.toStatus === 'CANCELLED',
    `${changed?.fromStatus} → ${changed?.toStatus}`)

  console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((e) => { console.error(e); process.exit(1) })
