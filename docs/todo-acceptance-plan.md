# 待办交付与验收改造方案（提交 → 验收 → 打回）

> 目标：把待办从「自己勾完成」升级为「提交 → 验收 → 打回」的闭环，
> 同时**不破坏**现有的会议状态联动与统计口径。
>
> 本文只做设计，不改代码。涉及现状的锚点均标注了文件与行号，便于对照。

---

## 0. 结论先看

| 问题 | 结论 |
|---|---|
| 核心改动 | `TodoStatus` 增加 `SUBMITTED`（待验收），**提交不落 `COMPLETED`** |
| 会议联动要不要改 | **不用改**。`SETTLED_TODO_STATUSES` 仍只认 `COMPLETED / CANCELLED`（`meetings.service.ts:1253`），`SUBMITTED` 天然不算完成 |
| 必须新增的表 | `todo_submissions`（提交记录）、`todo_attachments`（交付物）、`todo_events`（流转流水） |
| 必须补的字段 | `todos.assignee_user_id`、`todos.reviewer_id` |
| 验收何时生效 | `reviewer_id` 非空且 ≠ 提交人；为空则完全保持今天的行为 |
| 要不要新开「工作区」页 | **不要**。挂在待办操作上 + 收件箱「待我验收」，多一个要人主动刷的页面必死 |
| 工期 | Phase 0 前置 1–2 天；Phase 1 可用闭环 3–4 天；Phase 2 附件与历史 3–5 天 |
| 最大风险 | 待验收被当成已完成（统计假阳性）→ 由状态机 + 统计口径堵住 |

### 实施进度（2026-10-23）

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0 | ✅ 完成 | `assignee_user_id` / `reviewer_id` / `deadline_at` 已落库；AI 生成的负责人按「唯一同名」回填，重名一律留空 |
| Phase 1 | ✅ 完成 | `SUBMITTED` 状态、提交/验收/打回/撤回、`todo_submissions` / `todo_events`、收件箱「验收」分组、直改完成后门封死；`scripts/test-todo-acceptance.mjs` 29 项全绿 |
| Phase 2 | ✅ 完成 | 交付物上传与鉴权下载（单次 5 个 / 单文件 20MB / 扩展名白名单）、删除会议清理文件、24h 未验收催办（幂等）、看板待验收计数；测试扩到 38 项 + 催办 6 项 |
| Phase 3 | 🟡 大部分完成 | 截止时间自然语言解析（14 条单测）、逾期标记与收件箱排序、返工次数与平均验收时长统计、**验收要点清单**（最多 20 条，勾选留痕，待验收期间锁改）；**验收 SLA / 超时自动通过未做**（属于产品策略，需先定规则） |

与方案的偏差：

- `deadlineAt` 已支持相对表达（本周五 / 下周一 / 明天 / 3天内 / 月底）与月日，
  解析不了仍只保留文本；逾期判定只对「解析成功且未完成」的待办生效
- 「10月1日」这类已过去的月日会顺延到明年，避免刚创建就逾期 —— 这条规则对补录历史待办不友好，
  如需支持应显式带年份
- 验收清单是**建议性**的：未勾完也允许验收（接口返回 `uncheckedChecklist`），
  不做成硬门槛，避免要点过期后整条待办永远无法关闭
- **状态修改权限收紧**：只有**会议负责人（创建者/负责人）**、**该待办的负责人（提交对象）**或
  **超级管理员**能改 `OPEN / IN_PROGRESS / COMPLETED / CANCELLED`；成员与共享者一律 403。
  原方案允许成员勾选，实践里会让「谁负责」这条线断掉，故调整
- **提交与撤回都只认提交人本人**：会议负责人不能代交、也不能代撤；
  待办没指定负责人时提交会返回 403，需先改派。原方案的「负责人代提交」已取消
- **提交内容按「与待办相关」脱敏**：普通成员与共享者能看到提交人、次数、时间、状态，
  但说明、附件、打回原因在服务端直接置空，附件下载 403；打回事件的 metadata 也一并抹掉
- 附件按「先提交、再补传」两步实现（`POST /submissions/:id/attachments`），
  没有做成单次 multipart —— 提交本身可能失败，分开更容易重试，也让纯文字提交不依赖文件上传
- 验收人会在指定时自动加入会议成员（方案未写，但不加会导致验收人打不开会议）
- Phase 3（验收 SLA / 超时自动通过 / 返工率统计）未开始

---

## 1. 设计原则

1. **提交 ≠ 完成。** 交付是执行者的动作，完成是验收人的结论，两者不能合并成一个状态。
2. **状态是结果，事件是过程。** 所有流转写 `todo_events`，否则只能回答「完成没」，回答不了「为什么退回、返工几次」。
3. **验收可选。** 不设验收人的待办保持现状（一键完成），避免十人以下团队被流程压死。
4. **权限可降级，但不能绕过。** 成员能提交；只有验收人能通过；负责人可代验收但必须留痕。

---

## 2. 状态机

### 2.1 状态集合

在现有四态基础上只加一个：

```prisma
enum TodoStatus {
  OPEN
  IN_PROGRESS
  SUBMITTED   // 新增：已提交，等待验收
  COMPLETED
  CANCELLED
}
```

> 不新增 `REJECTED`。「被打回」是**提交记录**的属性（`todo_submissions.status = REJECTED`），
> 不是待办的生命周期状态。这样状态机只有 5 个节点，语义仍然完整，前端用提交记录上的角标表达「被退回」。

### 2.2 流转表

| 从 | 到 | 谁触发 | 前置条件 | 副作用 |
|---|---|---|---|---|
| `OPEN` | `IN_PROGRESS` | 会议负责人 / 待办负责人 / 超管 | 是负责人、提交对象或超管 | 写事件 |
| `OPEN` / `IN_PROGRESS` | `SUBMITTED` | 提交人（`assignee_user_id`） | 验收已启用；当前无 `PENDING` 提交 | 建提交记录（`attempt_no+1`）、通知验收人、写事件 |
| `IN_PROGRESS` | `COMPLETED` | 会议负责人 / 待办负责人 / 超管 | **验收未启用**（`reviewer_id` 为空） | 保持今天的旧行为 |
| `SUBMITTED` | `COMPLETED` | 验收人 / 会议负责人（代验收） | 提交为 `PENDING` | 提交置 `ACCEPTED`、写事件、通知提交人；触发会议状态同步 |
| `SUBMITTED` | `IN_PROGRESS` | 验收人 | 打回原因必填（≥5 字） | 提交置 `REJECTED`、记 `reject_reason`、通知提交人、写事件 |
| `SUBMITTED` | `IN_PROGRESS` | 提交人 | 提交为 `PENDING` | 提交置 `WITHDRAWN`、写事件 |
| 任意未完成态 | `CANCELLED` | 有编辑权 | — | 写事件；`PENDING` 提交一并置 `WITHDRAWN` |
| `COMPLETED` | `IN_PROGRESS` | 有编辑权（重开） | — | 保留历史提交，最新提交标记「已失效」 |

### 2.3 会议状态联动

`syncMeetingCompletionStatus` **一行都不用改**：

- `SUBMITTED` 不在 `SETTLED_TODO_STATUSES` 里 → 还有待验收时会议保持「进行中」
- 全部验收通过 → 会议自动「已完成」
- 打回 → 会议自动退回「进行中」（与今天待办改回 OPEN 的行为一致）

这一条是整个方案能不能成立的分水岭。**如果按「提交即 COMPLETED」实现，最后一条待办一提交，
会议就会被置为已完成，验收人隔一天打回时，这一天的看板、列表、导出全是假的。**

---

## 3. 数据模型

### 3.1 `todos` 增列

```prisma
model Todo {
  /// 结构化的负责人；文本 assignee 保留做展示与历史兼容
  assigneeUserId Int? @map("assignee_user_id")
  /// 验收人；为空表示该待办不需要验收（走旧的一键完成）
  reviewerId     Int? @map("reviewer_id")

  assigneeUser User? @relation("TodoAssignee", fields: [assigneeUserId], references: [id], onDelete: SetNull)
  reviewer     User? @relation("TodoReviewer", fields: [reviewerId], references: [id], onDelete: SetNull)
  submissions  TodoSubmission[]
  events       TodoEvent[]

  @@index([assigneeUserId, status])
  @@index([reviewerId, status])
}
```

**不引入 `acceptance_required` 布尔列**：验收是否启用由 `reviewer_id` 单一来源推导，
避免「有验收人但开关关着」这种自相矛盾的数据。需要关掉验收就把 `reviewer_id` 置空。

### 3.2 `todo_submissions`

```prisma
enum SubmissionStatus {
  PENDING     // 等待验收
  ACCEPTED    // 验收通过
  REJECTED    // 被打回
  WITHDRAWN   // 提交人撤回
}

model TodoSubmission {
  id           Int              @id @default(autoincrement())
  todoId       Int              @map("todo_id")
  submitterId  Int              @map("submitter_id")
  reviewerId   Int?             @map("reviewer_id")
  note         String?          @db.Text
  status       SubmissionStatus @default(PENDING)
  /// 第几次提交（打回后递增），用于统计返工次数
  attemptNo    Int              @default(1) @map("attempt_no")
  rejectReason String?          @map("reject_reason") @db.Text
  reviewedAt   DateTime?        @map("reviewed_at") @db.Timestamptz(3)
  createdAt    DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime         @updatedAt @map("updated_at") @db.Timestamptz(3)

  todo        Todo             @relation(fields: [todoId], references: [id], onDelete: Cascade)
  submitter   User             @relation("SubmissionSubmitter", fields: [submitterId], references: [id], onDelete: Cascade)
  reviewer    User?            @relation("SubmissionReviewer", fields: [reviewerId], references: [id], onDelete: SetNull)
  attachments TodoAttachment[]

  @@index([todoId, createdAt(sort: Desc)])
  @@index([status])
  @@map("todo_submissions")
}
```

**并发与重复提交用部分唯一索引兜住**（Prisma schema 表达不了，写在迁移 SQL 里）：

```sql
-- 同一条待办同时最多一条待验收记录
CREATE UNIQUE INDEX "todo_submissions_one_pending"
  ON "todo_submissions" ("todo_id")
  WHERE "status" = 'PENDING';
```

### 3.3 `todo_attachments`

| 字段 | 说明 |
|---|---|
| `submissionId` | 归属哪次提交 |
| `fileName` / `mimeType` / `sizeBytes` | 展示与限制 |
| `storedPath` | `uploads/todos/<todoId>/<uuid>.<ext>`，与 ASR 一样落 `uploads` 卷 |
| `createdAt` | — |

约束：单文件 ≤ 20MB，单次提交 ≤ 5 个文件，白名单
`pdf/doc/docx/xls/xlsx/ppt/pptx/zip/png/jpg/jpeg/md/txt`。

**下载必须走鉴权接口**（`GET /api/meetings/todos/:id/submissions/:sid/attachments/:aid`），
不要像早年的录音那样静态直出——静态目录会让权限形同虚设。

### 3.4 `todo_events`

| 字段 | 说明 |
|---|---|
| `todoId` / `actorId`（可空，账号删后保留） | 谁对哪条待办 |
| `type` | `created / assigned / submitted / accepted / rejected / withdrawn / status_changed / reopened / deadline_changed` |
| `fromStatus` / `toStatus` | 状态迁移 |
| `submissionId` | 关联提交（可空） |
| `metadata` | Json，存变更前后的值 |
| `createdAt` | 时间线排序 |

**不复用 `audit_logs`**：审计是管理员视角、按资源类型查，且 `audit:read` 权限门槛高；
待办时间线是业务视角，任何能看这场会议的人都该看到。两者受众不同，硬合并会让权限变糊。

### 3.5 为什么不能只加一个状态字段

只改 `todos.status` 能跑通流程，但答不了三个管理者一定会问的问题：

- 这条待办返工了几次？（`attempt_no`）
- 提交到验收平均隔多久？（`createdAt` → `reviewedAt`）
- 谁的交付老被打回？（按 `submitterId` 聚合 `REJECTED`）

这三个数字才是「验收」相对「勾完成」多出来的价值，否则只是多了两次点击。

---

## 4. 接口设计

| Method | Path | 权限 | 说明 |
|---|---|---|---|
| PATCH | `/api/meetings/todos/:id` | 写权限 | 扩展 `assigneeUserId`、`reviewerId`（后者需负责人及以上） |
| POST | `/api/meetings/todos/:id/submissions` | 提交人 | multipart：`note` + `files[]`，创建 `PENDING` 提交并把待办置 `SUBMITTED` |
| POST | `/api/meetings/todos/:id/submissions/:sid/accept` | 验收人 / 负责人代验收 | 提交置 `ACCEPTED`，待办置 `COMPLETED`，同步会议状态 |
| POST | `/api/meetings/todos/:id/submissions/:sid/reject` | 验收人 | body `{ reason }`（必填），提交置 `REJECTED`，待办回 `IN_PROGRESS` |
| POST | `/api/meetings/todos/:id/submissions/:sid/withdraw` | 提交人 | 仅 `PENDING` 可撤回 |
| POST | `/api/meetings/submissions/:id/attachments` | 提交人 / 负责人 | 补充交付物（multipart `file`，≤20MB，单次最多 5 个） |
| GET | `/api/meetings/todos/:todoId/submissions/:sid/attachments/:aid` | 可见会议者 | 鉴权下载，强制 `attachment` + `nosniff` |
| PUT | `/api/meetings/todos/:id/checklist` | 写权限 | 覆盖式设置验收要点；待验收期间 409 |
| PATCH | `/api/meetings/todos/:id/checklist/:itemId` | 可编辑待办者 | 勾选 / 取消一条要点，记录勾选人与时间 |
| GET | `/api/meetings/todos/:id/submissions` | 可见会议者 | 时间线（含附件元信息） |
| GET | `/api/meetings/todos/:id/submissions/:sid/attachments/:aid` | 可见会议者 | 鉴权下载 |
| GET | `/api/inbox` | 登录 | 返回新增分组 `reviews`（待我验收）、`mySubmissions`（我被退回的） |
| GET | `/api/meetings/:id` | 可见会议者 | 待办附带 `latestSubmission` 摘要，避免前端 N+1 |

**并发控制**：所有流转用条件更新，不要先读后写。

```ts
const { count } = await tx.todo.updateMany({
  where: { id, status: 'SUBMITTED' },
  data: { status: 'COMPLETED' },
});
if (count === 0) throw new ConflictException('待办状态已变化，请刷新后重试');
```

---

## 5. 权限矩阵

| 动作 | 提交人 | 验收人 | 会议负责人 | 会议成员 | 超管 |
|---|:---:|:---:|:---:|:---:|:---:|
| 提交 | ✅ | — | ❌ | ❌ | ❌ |
| 撤回 | ✅（仅 PENDING） | ❌ | ❌ | ❌ | ❌ |
| 验收通过 / 打回 | ❌（自己不能验自己） | ✅ | ✅（记 `forced`） | ❌ | ✅ |
| 查看提交内容（说明/附件/打回原因） | ✅ | ✅ | ✅ | ❌（仅提交人/次数/时间/状态） | ✅ |
| 直接改 `COMPLETED` | ❌ | ❌ | ❌（改走代验收） | ❌ | ❌ |

三条硬规则：

1. **验收启用后，`PATCH /todos/:id/status` 不允许直接写 `COMPLETED`**，返回 409 并提示「请先验收」。
   否则这条路径会成为整个流程的后门（现在任何成员都能直接勾完成，`meetings.service.ts:1211`）。
2. **`reviewer_id === submitterId` 时自动通过**（提交即完成），只记录提交，不制造「自己审自己」的假流程。
3. **负责人代验收必须写审计**：`audit_logs.action = todo.accept_forced`，用于事后追溯。

---

## 6. 通知与收件箱

新增三类落库消息（`meeting_notices.kind`）：

| kind | 收件人 | 正文示例 |
|---|---|---|
| `todo_submitted` | 验收人 | 「李雷提交了待办『接口联调』，等待你验收」 |
| `todo_rejected` | 提交人 | 「待办『接口联调』被打回：缺少压测报告」 |
| `todo_accepted` | 提交人 | 「待办『接口联调』已验收通过」 |

注意：现有的会议提醒靠部分唯一索引做幂等，**只约束 `kind='reminder'`**，新增 kind 不会撞索引；
但上线前要核对一次那条迁移 SQL，确认条件里带 `kind` 过滤。

收件箱与订阅：

- 「待我验收」进**通知**分组（复用现有未读角标机制，`inbox_reads` 按 `item_key` 记已读）
- 提交后 **24 小时未验收**发一次催办；复用 `sendDueReminders` 的每分钟扫描，
  但查询要按 `status = 'PENDING' AND created_at < now() - 24h` 走索引，别扫全表
- 打回通知必须带原因，不带原因的通知等于没发

---

## 7. 迁移与兼容

| 迁移 | 内容 | 可回滚性 |
|---|---|---|
| `add_todo_assignee_reviewer` | `todos` 加两列（可空）+ 索引 | 可 drop 列，无数据损失 |
| `add_todo_submission` | 三张新表 + 部分唯一索引 | 可 drop 表 |
| （可选）`backfill_todo_assignee` | 文本 → `assignee_user_id` 的一次性回填 | 只写新列，可重跑 |

回填脚本的要求：

- **dry-run 先行**：只回填「姓名唯一且完全相等」的待办，输出待人工确认清单
- 重名、模糊匹配一律不猜（`张三` / `张三丰` 现在会被 `includes` 误命中，正是要修的）
- 回填结果写 `todo_events(type='assigned')`，保留来源标记 `source: 'backfill'`

兼容性：

- `reviewer_id` 为空 → 行为与今天完全一致，老前端不受影响
- 老接口 `PATCH /todos/:id/status` 仍可用，只是 `COMPLETED` 在有验收人时被拒
- 前端灰度：先用环境变量 `TODO_ACCEPTANCE_ENABLED` 控制入口显隐，稳定后去掉

---

## 8. 前端改动

| 位置 | 改动 |
|---|---|
| 待办行 | 五态标签（待验收 = 琥珀色）；显示「查看 / 提交 / 撤回 / 记录」；通过、打回放在「查看」弹窗内；被打回显示退回原因气泡 |
| 待办详情抽屉（新增） | 提交历史时间线：谁、何时、说明、附件、结论；打回原因必填输入 |
| 收件箱 | 新增「待我验收」分组 + 未读数；「我被退回」单独一组 |
| 看板 | 完成率口径标注为「已完成 = 验收通过」；新增「待验收 N 条」计数 |
| 会议详情表头 | 保留现有联动，增加「N 条待验收」提示，避免误判会议进度 |

交互原则：**提交与验收都在待办上就地完成**，不跳页面。收件箱点进来要能直接落到那一条待办。

---

## 9. 分阶段落地

| 阶段 | 内容 | 工期 | 产出 |
|---|---|---|---|
| Phase 0（前置） | `assignee` → `assignee_user_id`；`deadline` → `DateTime?`（保留 `deadline_text`） | 1–2 天 | 归属稳定，逾期可判 |
| Phase 1（最小闭环） | `SUBMITTED` + 提交/验收/打回 + 事件表 + 收件箱 + 权限收紧 | 3–4 天 | 能用的「提交—验收」 |
| Phase 2 | 附件上传与鉴权下载 + 提交历史 + 24h 催办 + 看板口径 | 3–5 天 | 可交付物留痕 |
| Phase 3（可选） | 截止时间自然语言解析 ✅、逾期标记与统计 ✅、验收 SLA / 超时自动通过 ❌ | 部分完成 | 管理价值 |

**Phase 0 不能省。** 没有 `assignee_user_id`，「谁能提交」只能靠姓名字符串猜；
没有 `deadline` 的时间类型，「逾期未提交」永远算不出来。这两步是后面所有能力的地基。

---

## 10. 验收标准（可直接写成测试）

1. 提交后会议状态**不变**（仍为进行中），待办显示「待验收」
2. 全部待办处于待验收时，会议**不会**变成已完成
3. 验收通过后会议自动完成；打回后自动退回进行中
4. 打回不填原因 → 400；原因 < 5 字 → 400
5. 非验收人调 `accept` → 403；重复 `accept` → 409
6. 有验收人的待办，直接 `PATCH status=COMPLETED` → 409
7. 撤回后可重新提交，`attempt_no` 递增，时间线保留两次记录
8. `reviewer_id` 为空的待办，全部行为与改造前一致（回归用例）
9. 删除会议 → 提交记录、附件、事件级联清理，`uploads` 无孤儿文件
10. 收件箱未读数包含待验收项；点开后该条已读且不影响其他条

---

## 11. 非目标（这期不做）

- 多级审批 / 会签
- 跨会议的工作区视图（收件箱已经承担聚合，不再开第二个入口）
- 验收评分、绩效排名
- 交付物的在线预览与协同编辑
- 移动端 App（先保证 375px 下可完成提交与验收）

---

## 12. 风险与对策

| 风险 | 表现 | 对策 |
|---|---|---|
| 流程被绕过 | 成员直接勾完成，验收形同虚设 | 有验收人时封死 `COMPLETED` 直改，409 引导走验收 |
| 待验收积压 | 提交后没人管，会议永远「进行中」 | 24h 催办 + 收件箱未读 + 负责人可代验收 |
| 假完成 | 提交即置完成，会议被提前关闭 | `SUBMITTED` 不计入 `SETTLED`，统计口径标注 |
| 归属错人 | 文本匹配把「张三丰」认成「张三」 | Phase 0 落 `assignee_user_id`，文本仅做展示兜底 |
| 附件膨胀 | `uploads` 卷无上限 | 单文件 20MB / 单次 5 个；删除会议清理；定期扫孤儿 |
| 流程太重 | 小团队嫌麻烦，整体弃用 | 验收可选（`reviewer_id` 为空即旧行为）；提交不强制填说明 |
| 状态震荡 | 打回-提交反复，会议状态来回跳 | 每次流转记事件；统计只取「验收通过」为终态；不做实时推送轰炸 |
