/**
 * 待办「提交 → 验收 → 打回」全链路验证（只在本地库跑）。
 *
 * 覆盖：
 * 1. 结构化的负责人/验收人写入，验收人自动成为会议成员
 * 2. 提交后待办进入待验收，**会议状态不变**
 * 3. 待验收期间不能直接勾完成、不能直接改成待验收
 * 4. 自己不能验收自己提交的交付
 * 5. 打回原因必填（≥5 字），打回后待办退回进行中
 * 6. 二次提交 attemptNo 递增，验收通过后会议自动完成
 * 7. 收件箱「待我验收」可见，且计入未读数
 */
const BASE = 'http://127.0.0.1:3100/api'

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
const PASSWORD = 'Passw0rd!'

/** multipart 上传：Node 22 自带 FormData / Blob，不需要额外依赖 */
const uploadFile = async (
  submissionId,
  token,
  fileName,
  content,
  type = 'text/plain'
) => {
  const form = new FormData()
  form.append('file', new Blob([content], { type }), fileName)

  const response = await fetch(
    `${BASE}/meetings/submissions/${submissionId}/attachments`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }
  )

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  return { status: response.status, data }
}

const run = async () => {
  const regA = await call('/auth/register', {
    method: 'POST',
    body: { phone: PHONE_A, password: PASSWORD, name: '交付测试甲' },
  })
  check('注册提交人 A', regA.status === 200 || regA.status === 201, JSON.stringify(regA.data))

  const regB = await call('/auth/register', {
    method: 'POST',
    body: { phone: PHONE_B, password: PASSWORD, name: '验收测试乙' },
  })
  check('注册验收人 B', regB.status === 200 || regB.status === 201, JSON.stringify(regB.data))

  // 与会议无关的第三方：用来验证附件下载的鉴权
  const phoneC = `139${String(Number(stamp) + 2).padStart(8, '0')}`
  const regC = await call('/auth/register', {
    method: 'POST',
    body: { phone: phoneC, password: PASSWORD, name: '旁观测试丙' },
  })
  check('注册无关用户 C', regC.status === 200 || regC.status === 201, JSON.stringify(regC.data))

  // 普通成员 D：只加入会议，不负责任何待办、也不是验收人
  const phoneD = `139${String(Number(stamp) + 3).padStart(8, '0')}`
  const regD = await call('/auth/register', {
    method: 'POST',
    body: { phone: phoneD, password: PASSWORD, name: '普通成员丁' },
  })
  check('注册普通成员 D', regD.status === 200 || regD.status === 201, JSON.stringify(regD.data))

  const loginA = await call('/auth/login', {
    method: 'POST',
    body: { phone: PHONE_A, password: PASSWORD },
  })
  const loginB = await call('/auth/login', {
    method: 'POST',
    body: { phone: PHONE_B, password: PASSWORD },
  })

  const tokenA = loginA.data?.token
  const tokenB = loginB.data?.token
  const meA = await call('/auth/me', { token: tokenA })
  const meB = await call('/auth/me', { token: tokenB })
  const userA = meA.data?.id
  const userB = meB.data?.id

  const loginC = await call('/auth/login', {
    method: 'POST',
    body: { phone: phoneC, password: PASSWORD },
  })
  const tokenC = loginC.data?.token

  const loginD = await call('/auth/login', {
    method: 'POST',
    body: { phone: phoneD, password: PASSWORD },
  })
  const tokenD = loginD.data?.token
  const meD = await call('/auth/me', { token: tokenD })
  const userD = meD.data?.id

  check('两人登录成功', !!tokenA && !!tokenB && !!userA && !!userB)
  check('无关用户登录成功', !!tokenC)
  check('普通成员登录成功', !!tokenD && !!userD)

  const meeting = await call('/meetings', {
    method: 'POST',
    token: tokenA,
    body: { title: '交付验收链路测试', content: '这是一场用于验证交付与验收流程的会议。' },
  })
  const meetingId = meeting.data?.id
  check('创建会议', meeting.status === 200 || meeting.status === 201, JSON.stringify(meeting.data))

  const created = await call(`/meetings/${meetingId}/todos`, {
    method: 'POST',
    token: tokenA,
    body: {
      content: '完成接口联调并提交报告',
      assigneeUserId: userA,
      reviewerId: userB,
      deadline: '2026-11-02',
    },
  })
  const todoId = created.data?.id
  check('新增待办（带负责人与验收人）', created.status === 200 || created.status === 201, JSON.stringify(created.data))
  check('截止日期被解析为 deadlineAt', !!created.data?.deadlineAt, JSON.stringify(created.data))

  const meetingAfterCreate = await call(`/meetings/${meetingId}`, { token: tokenA })
  const todoAfterCreate = meetingAfterCreate.data?.todos?.find((t) => t.id === todoId)
  check('详情返回结构化归属', todoAfterCreate?.assigneeUserId === userA && todoAfterCreate?.reviewerId === userB, JSON.stringify(todoAfterCreate))
  check('待办初始为 OPEN', todoAfterCreate?.status === 'OPEN', todoAfterCreate?.status)

  const checklist = await call(`/meetings/todos/${todoId}/checklist`, {
    method: 'PUT',
    token: tokenA,
    body: { items: ['接口返回结构与文档一致', '压测 QPS ≥ 200'] },
  })
  check('设置验收要点', checklist.data?.checklist?.length === 2, JSON.stringify(checklist.data))

  const checklistItemId = checklist.data?.checklist?.[0]?.id

  const detailWithChecklist = await call(`/meetings/${meetingId}`, { token: tokenA })
  const todoWithChecklist = detailWithChecklist.data?.todos?.find((t) => t.id === todoId)
  check('详情带出清单进度', todoWithChecklist?.checklistTotal === 2 && todoWithChecklist?.checklistDone === 0, JSON.stringify({ total: todoWithChecklist?.checklistTotal, done: todoWithChecklist?.checklistDone }))

  const toggled = await call(`/meetings/todos/${todoId}/checklist/${checklistItemId}`, {
    method: 'PATCH',
    token: tokenA,
    body: { done: true },
  })
  check('勾选验收要点', toggled.data?.done === true && !!toggled.data?.doneByName, JSON.stringify(toggled.data))

  const toggleByOutsider = await call(`/meetings/todos/${todoId}/checklist/${checklistItemId}`, {
    method: 'PATCH',
    token: tokenC,
    body: { done: false },
  })
  check('无关用户不能勾选验收要点', toggleByOutsider.status === 404, String(toggleByOutsider.status))

  const meetingAsB = await call(`/meetings/${meetingId}`, { token: tokenB })
  check('验收人自动成为成员，可直接打开会议', meetingAsB.status === 200, JSON.stringify(meetingAsB.data))

  const todoAsB = meetingAsB.data?.todos?.find((t) => t.id === todoId)
  check('非负责人没有改状态入口', todoAsB?.canChangeStatus === false, String(todoAsB?.canChangeStatus))

  const statusByB = await call(`/meetings/todos/${todoId}/status`, {
    method: 'PATCH',
    token: tokenB,
    body: { status: 'IN_PROGRESS' },
  })
  check('非负责人不能修改状态', statusByB.status === 403, `${statusByB.status} ${JSON.stringify(statusByB.data)}`)

  const statusByA = await call(`/meetings/todos/${todoId}/status`, {
    method: 'PATCH',
    token: tokenA,
    body: { status: 'IN_PROGRESS' },
  })
  check('负责人可以修改状态', statusByA.status === 200, String(statusByA.status))

  const directComplete = await call(`/meetings/todos/${todoId}/status`, {
    method: 'PATCH',
    token: tokenA,
    body: { status: 'COMPLETED' },
  })
  check('有验收人时不能直接勾完成', directComplete.status === 409, `${directComplete.status} ${JSON.stringify(directComplete.data)}`)

  const directSubmitStatus = await call(`/meetings/todos/${todoId}/status`, {
    method: 'PATCH',
    token: tokenA,
    body: { status: 'SUBMITTED' },
  })
  check('不能直接把状态改成待验收', directSubmitStatus.status === 400, `${directSubmitStatus.status}`)

  const submit1 = await call(`/meetings/todos/${todoId}/submissions`, {
    method: 'POST',
    token: tokenA,
    body: { note: '接口已联调通过，报告见会议室白板' },
  })
  const submission1 = submit1.data?.id
  check('提交交付', (submit1.status === 200 || submit1.status === 201) && submit1.data?.status === 'PENDING', JSON.stringify(submit1.data))

  const afterSubmit = await call(`/meetings/${meetingId}`, { token: tokenA })
  const todoSubmitted = afterSubmit.data?.todos?.find((t) => t.id === todoId)
  check('提交后待办为待验收', todoSubmitted?.status === 'SUBMITTED', todoSubmitted?.status)
  check('提交后会议仍是进行中（提交不算完成）', afterSubmit.data?.completionStatus === 'IN_PROGRESS', afterSubmit.data?.completionStatus)

  const lockedChecklist = await call(`/meetings/todos/${todoId}/checklist`, {
    method: 'PUT',
    token: tokenA,
    body: { items: ['待验收期间换清单'] },
  })
  check('待验收期间不能修改验收要点', lockedChecklist.status === 409, String(lockedChecklist.status))

  const inboxB = await call('/inbox', { token: tokenB })
  const reviews = inboxB.data?.reviews ?? []
  check('验收人收件箱出现待验收', reviews.some((r) => r.submissionId === submission1), JSON.stringify(inboxB.data?.reviews))
  check('待验收计入未读数', (inboxB.data?.unreadCount ?? 0) >= 1, String(inboxB.data?.unreadCount))

  const uploaded = await uploadFile(
    submission1,
    tokenA,
    '接口联调记录.txt',
    '接口联调记录：全部用例通过，等待验收'
  )
  check('上传交付物', (uploaded.status === 200 || uploaded.status === 201) && !!uploaded.data?.id, JSON.stringify(uploaded.data))

  const badExt = await uploadFile(submission1, tokenA, 'payload.exe', 'MZ')
  check('非法扩展名被拒', badExt.status === 400, String(badExt.status))

  const downloadUrl = `${BASE}/meetings/todos/${todoId}/submissions/${submission1}/attachments/${uploaded.data?.id}`

  const downloaded = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${tokenA}` },
  })
  const downloadedText = await downloaded.text()
  check(
    '提交人可下载且内容一致',
    downloaded.status === 200 && downloadedText.includes('全部用例通过'),
    `${downloaded.status} ${downloadedText.slice(0, 40)}`
  )

  const downloadedByReviewer = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${tokenB}` },
  })
  check('验收人可下载', downloadedByReviewer.status === 200, String(downloadedByReviewer.status))

  const downloadedByOutsider = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${tokenC}` },
  })
  check('无关用户下载返回 404', downloadedByOutsider.status === 404, String(downloadedByOutsider.status))

  const selfAccept = await call(`/meetings/submissions/${submission1}/accept`, {
    method: 'POST',
    token: tokenA,
  })
  check('不能验收自己提交的交付', selfAccept.status === 403, `${selfAccept.status}`)

  const shortReject = await call(`/meetings/submissions/${submission1}/reject`, {
    method: 'POST',
    token: tokenB,
    body: { reason: '不行' },
  })
  check('打回原因过短被拒', shortReject.status === 400, String(shortReject.status))

  const reject1 = await call(`/meetings/submissions/${submission1}/reject`, {
    method: 'POST',
    token: tokenB,
    body: { reason: '缺少接口联调记录，请补充截图后重新提交' },
  })
  check('打回成功', (reject1.status === 200 || reject1.status === 201) && reject1.data?.status === 'REJECTED', JSON.stringify(reject1.data))

  const afterReject = await call(`/meetings/${meetingId}`, { token: tokenA })
  const todoRejected = afterReject.data?.todos?.find((t) => t.id === todoId)
  check('打回后待办退回进行中', todoRejected?.status === 'IN_PROGRESS', todoRejected?.status)
  check('打回原因展示在最近提交上', todoRejected?.latestSubmission?.rejectReason?.includes('联调记录'), JSON.stringify(todoRejected?.latestSubmission))

  const submit2 = await call(`/meetings/todos/${todoId}/submissions`, {
    method: 'POST',
    token: tokenA,
    body: { note: '已补充联调截图' },
  })
  check('二次提交 attemptNo 递增到 2', submit2.data?.attemptNo === 2, JSON.stringify(submit2.data))

  const accept2 = await call(`/meetings/submissions/${submit2.data?.id}/accept`, {
    method: 'POST',
    token: tokenB,
  })
  check('验收通过', (accept2.status === 200 || accept2.status === 201) && accept2.data?.status === 'ACCEPTED', JSON.stringify(accept2.data))
  check('验收返回未勾选的要点数', accept2.data?.uncheckedChecklist === 1, String(accept2.data?.uncheckedChecklist))
  check('全部待办完成后会议自动完成', accept2.data?.meetingCompletionStatus === 'COMPLETED', accept2.data?.meetingCompletionStatus)

  const lateUpload = await uploadFile(submit2.data?.id, tokenA, '补充说明.txt', '验收后再补')
  check('验收后不能再补附件', lateUpload.status === 409, String(lateUpload.status))

  const timeline = await call(`/meetings/todos/${todoId}/submissions`, { token: tokenA })
  check('提交时间线两条记录', Array.isArray(timeline.data) && timeline.data.length === 2, JSON.stringify(timeline.data))
  check('时间线状态为通过/打回', timeline.data?.[0]?.status === 'ACCEPTED' && timeline.data?.[1]?.status === 'REJECTED', JSON.stringify(timeline.data?.map((d) => d.status)))
  check('时间线带出交付物', timeline.data?.[1]?.attachments?.length === 1, JSON.stringify(timeline.data?.[1]?.attachments))

  /**
   * 内容可见性：普通成员只能看到提交次数、时间、状态，
   * 说明 / 附件 / 提交人 / 打回原因都必须被后端抹掉，不能只靠前端隐藏。
   */
  const submissionsA = await call(`/meetings/todos/${todoId}/submissions`, { token: tokenA })
  check(
    '相关人仍能看到提交内容',
    (submissionsA.data?.length ?? 0) >= 2 &&
      submissionsA.data.every((s) => s.canViewContent === true && s.submitter !== null),
    JSON.stringify(submissionsA.data?.[0])
  )

  const addMemberD = await call(`/meetings/${meetingId}/members`, {
    method: 'POST',
    token: tokenA,
    body: { userId: userD },
  })
  check('把普通成员 D 加入会议', addMemberD.status === 200 || addMemberD.status === 201, `${addMemberD.status} ${JSON.stringify(addMemberD.data)}`)

  const detailD = await call(`/meetings/${meetingId}`, { token: tokenD })
  const todoForD = detailD.data?.todos?.find((t) => t.id === todoId)
  check('普通成员无权查看提交内容', todoForD?.canViewSubmissionContent === false, String(todoForD?.canViewSubmissionContent))

  const submissionsD = await call(`/meetings/todos/${todoId}/submissions`, { token: tokenD })
  check(
    '普通成员能看到提交人，但看不到内容',
    (submissionsD.data?.length ?? 0) >= 2 &&
      submissionsD.data.every(
        (s) =>
          s.canViewContent === false &&
          s.note === null &&
          s.rejectReason === null &&
          !!s.submitter?.name &&
          Array.isArray(s.attachments) &&
          s.attachments.length === 0
      ),
    JSON.stringify(submissionsD.data?.[0])
  )

  const downloadByD = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${tokenD}` },
  })
  check('普通成员不能下载交付物', downloadByD.status === 403, String(downloadByD.status))

  const eventsD = await call(`/meetings/todos/${todoId}/events`, { token: tokenD })
  const rejectedEventForD = (eventsD.data ?? []).find((e) => e.type === 'rejected')
  check('普通成员看不到打回原因', rejectedEventForD?.metadata === null, JSON.stringify(rejectedEventForD?.metadata))

  const events = await call(`/meetings/todos/${todoId}/events`, { token: tokenA })
  const types = (events.data ?? []).map((e) => e.type)
  check('流转流水包含提交/打回/通过', ['created', 'submitted', 'rejected', 'accepted'].every((t) => types.includes(t)), JSON.stringify(types))

  /**
   * 自然语言截止时间 + 逾期
   * 用一条新待办验证：先写「明天」确认能解析，再改成过去的日期确认 overdue。
   */
  const naturalTodo = await call(`/meetings/${meetingId}/todos`, {
    method: 'POST',
    token: tokenA,
    body: { content: '自然语言截止时间待办', assigneeUserId: userA, deadline: '明天' },
  })
  const naturalTodoId = naturalTodo.data?.id

  check('「明天」被解析成时间点', !!naturalTodo.data?.deadlineAt, JSON.stringify(naturalTodo.data))

  await call(`/meetings/todos/${naturalTodoId}`, {
    method: 'PATCH',
    token: tokenA,
    body: { deadline: '2026-01-01' },
  })

  const overdueDetail = await call(`/meetings/${meetingId}`, { token: tokenA })
  const overdueTodo = overdueDetail.data?.todos?.find((t) => t.id === naturalTodoId)
  check('过期未完成标记为逾期', overdueTodo?.overdue === true, JSON.stringify(overdueTodo))

  const stats = await call('/meetings/stats', { token: tokenA })
  check('统计返回逾期数量', stats.data?.overdueTodos >= 1, String(stats.data?.overdueTodos))
  check('统计返回返工次数', stats.data?.reworkCount >= 1, String(stats.data?.reworkCount))
  check('统计返回平均验收时长', typeof stats.data?.avgReviewHours === 'number', String(stats.data?.avgReviewHours))
  check('统计返回待验收数量', typeof stats.data?.pendingReviewTodos === 'number', String(stats.data?.pendingReviewTodos))

  /** 没有负责人时的兜底：会议负责人可改，普通成员仍不行 */
  const unassignedTodo = await call(`/meetings/${meetingId}/todos`, {
    method: 'POST',
    token: tokenA,
    body: { content: '没有负责人的待办' },
  })

  const unassignedId = unassignedTodo.data?.id

  const ownerFallback = await call(`/meetings/todos/${unassignedId}/status`, {
    method: 'PATCH',
    token: tokenA,
    body: { status: 'IN_PROGRESS' },
  })
  check('无负责人时会议负责人可改状态', ownerFallback.status === 200, String(ownerFallback.status))

  const memberFallback = await call(`/meetings/todos/${unassignedId}/status`, {
    method: 'PATCH',
    token: tokenB,
    body: { status: 'OPEN' },
  })
  check('无负责人时普通成员仍不能改状态', memberFallback.status === 403, String(memberFallback.status))

  /** 会议负责人可以改别人负责的待办；该待办负责人自己也可以改 */
  const forBTodo = await call(`/meetings/${meetingId}/todos`, {
    method: 'POST',
    token: tokenA,
    body: { content: '指派给验收人的待办', assigneeUserId: userB },
  })
  const forBId = forBTodo.data?.id

  const leaderOverOther = await call(`/meetings/todos/${forBId}/status`, {
    method: 'PATCH',
    token: tokenA,
    body: { status: 'IN_PROGRESS' },
  })
  check('会议负责人可改他人负责的待办', leaderOverOther.status === 200, String(leaderOverOther.status))

  const assigneeSelf = await call(`/meetings/todos/${forBId}/status`, {
    method: 'PATCH',
    token: tokenB,
    body: { status: 'OPEN' },
  })
  check('待办负责人可改自己的待办', assigneeSelf.status === 200, String(assigneeSelf.status))

  const detailForB = await call(`/meetings/${meetingId}`, { token: tokenB })
  const forBDetail = detailForB.data?.todos?.find((t) => t.id === forBId)
  check('待办负责人看到改状态入口', forBDetail?.canChangeStatus === true, String(forBDetail?.canChangeStatus))

  /** 提交是负责人的动作：会议负责人也不能代交；撤回只有提交人能做 */
  const detailForALeader = await call(`/meetings/${meetingId}`, { token: tokenA })
  const forBForLeader = detailForALeader.data?.todos?.find((t) => t.id === forBId)
  check('负责人看不到他人待办的提交按钮', forBForLeader?.canSubmit === false, String(forBForLeader?.canSubmit))

  const submitByLeader = await call(`/meetings/todos/${forBId}/submissions`, {
    method: 'POST',
    token: tokenA,
    body: { note: '负责人尝试代提交' },
  })
  check('会议负责人不能代提交', submitByLeader.status === 403, `${submitByLeader.status} ${JSON.stringify(submitByLeader.data)}`)

  const submitByAssignee = await call(`/meetings/todos/${forBId}/submissions`, {
    method: 'POST',
    token: tokenB,
    body: { note: '负责人本人提交' },
  })
  const behalfSubmissionId = submitByAssignee.data?.id
  check('待办负责人可以提交', submitByAssignee.status === 200 || submitByAssignee.status === 201, `${submitByAssignee.status} ${JSON.stringify(submitByAssignee.data)}`)

  const submittedDetailA = await call(`/meetings/${meetingId}`, { token: tokenA })
  const submittedForBForLeader = submittedDetailA.data?.todos?.find((t) => t.id === forBId)
  check('非提交人看不到撤回按钮', submittedForBForLeader?.canWithdraw === false, String(submittedForBForLeader?.canWithdraw))

  const withdrawByLeader = await call(`/meetings/submissions/${behalfSubmissionId}/withdraw`, {
    method: 'POST',
    token: tokenA,
  })
  check('非提交人不能撤回（即使是会议负责人）', withdrawByLeader.status === 403, String(withdrawByLeader.status))

  const withdrawByB = await call(`/meetings/submissions/${behalfSubmissionId}/withdraw`, {
    method: 'POST',
    token: tokenB,
  })
  check('提交人可以撤回', (withdrawByB.status === 200 || withdrawByB.status === 201) && withdrawByB.data?.status === 'WITHDRAWN', JSON.stringify(withdrawByB.data))

  const duplicateAccept = await call(`/meetings/submissions/${submit2.data?.id}/accept`, {
    method: 'POST',
    token: tokenB,
  })
  check('重复验收返回 409', duplicateAccept.status === 409, String(duplicateAccept.status))

  /**
   * 超级管理员例外未放进本脚本：
   * users 表有「全局唯一一个 SUPER_ADMIN」的部分唯一索引，测试里不能临时造第二个。
   * 该分支已单独验证：临时降级现有超管 → 提升测试账号 → 改他人待办 200 → 立即恢复。
   */
  const deleted = await call(`/meetings/${meetingId}`, { method: 'DELETE', token: tokenA })
  check('删除会议', deleted.status === 204 || deleted.status === 200, String(deleted.status))

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
