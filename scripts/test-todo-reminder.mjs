/**
 * 待验收 24 小时催办验证（只在本地库跑）。
 *
 * 不依赖「等 24 小时」：先把提交的 created_at 改到 25 小时前，
 * 再直接调用编译后的 InboxService.sendSubmissionReminders()。
 *
 * 覆盖：催办发给验收人、只发一次（幂等）、内容带待办名。
 *
 * 运行：node --env-file=.env scripts/test-todo-reminder.mjs
 * 前置：后端已 build（需要 dist/inbox/inbox.service.js），本地库容器在跑。
 */
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { PrismaService } = require('../backend/dist/common/prisma.service.js')
const { InboxService } = require('../backend/dist/inbox/inbox.service.js')

const BASE = 'http://127.0.0.1:3100/api'
const PASSWORD = 'Passw0rd!'

let passed = 0
let failed = 0

const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name} ${String(detail).slice(0, 300)}`)
  }
}

const call = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  return { status: response.status, data }
}

const stamp = String(Date.now()).slice(-8)
const PHONE_A = `139${stamp}`
const PHONE_B = `139${String(Number(stamp) + 1).padStart(8, '0')}`

const run = async () => {
  const regA = await call('/auth/register', {
    method: 'POST',
    body: { phone: PHONE_A, password: PASSWORD, name: '催办测试甲' },
  })
  const regB = await call('/auth/register', {
    method: 'POST',
    body: { phone: PHONE_B, password: PASSWORD, name: '催办测试乙' },
  })
  check('注册两个测试账号', [regA, regB].every((r) => r.status === 200 || r.status === 201), JSON.stringify([regA.status, regB.status]))

  const loginA = await call('/auth/login', { method: 'POST', body: { phone: PHONE_A, password: PASSWORD } })
  const loginB = await call('/auth/login', { method: 'POST', body: { phone: PHONE_B, password: PASSWORD } })
  const tokenA = loginA.data?.token

  const meA = await call('/auth/me', { token: tokenA })
  const meB = await call('/auth/me', { token: loginB.data?.token })
  const userA = meA.data?.id
  const userB = meB.data?.id

  const meeting = await call('/meetings', {
    method: 'POST',
    token: tokenA,
    body: { title: '催办测试会议', content: '用于验证 24 小时未验收催办。' },
  })
  const meetingId = meeting.data?.id

  const todo = await call(`/meetings/${meetingId}/todos`, {
    method: 'POST',
    token: tokenA,
    body: { content: '提交一份迟迟没人验收的交付', assigneeUserId: userA, reviewerId: userB },
  })

  const todoId = todo.data?.id

  const submit = await call(`/meetings/todos/${todoId}/submissions`, {
    method: 'POST',
    token: tokenA,
    body: { note: '已交付，等待验收' },
  })
  const submissionId = submit.data?.id
  check('创建并提交待办', !!meetingId && !!todoId && submit.data?.status === 'PENDING', JSON.stringify(submit.data))

  // 把提交时间改到 25 小时前，跳过等待
  execSync(
    `docker exec meetmind-postgres psql -U postgres -d meetmind -c "UPDATE todo_submissions SET created_at = now() - interval '25 hours' WHERE id = ${submissionId}"`,
    { stdio: 'ignore' }
  )

  const prisma = new PrismaService()
  await prisma.$connect()

  try {
    const inbox = new InboxService(prisma)

    await inbox.sendSubmissionReminders()
    await inbox.sendSubmissionReminders()

    const notices = await prisma.meetingNotice.findMany({
      where: { meetingId, kind: 'todo_review_overdue' },
    })

    check('催办只发一条（幂等）', notices.length === 1, `实际 ${notices.length} 条`)
    check('催办发给验收人', notices[0]?.userId === userB, JSON.stringify(notices[0]))
    check('催办内容包含待办名', notices[0]?.content?.includes('迟迟没人验收'), notices[0]?.content)

    const row = await prisma.todoSubmission.findUnique({ where: { id: submissionId } })
    check('已记录催办时间', !!row?.reminderSentAt, String(row?.reminderSentAt))
  } finally {
    await prisma.$disconnect()
  }

  await call(`/meetings/${meetingId}`, { method: 'DELETE', token: tokenA })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
