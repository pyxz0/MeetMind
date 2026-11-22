import { buildTodoNotices } from './todo-notices';

/**
 * 待办变更通知的触发条件。
 *
 * 重点覆盖「谁是操作者」这一维：自己给自己指派不该收到通知，
 * 但把活转交出去时，原负责人一定要收到 —— 否则他会继续做一件
 * 已经不归他的事。
 */
describe('buildTodoNotices', () => {
  const base = {
    content: '整理会议纪要',
    assigneeUserId: 10 as number | null,
    reviewerId: 20 as number | null,
    deadline: '下周一' as string | null,
  };

  const build = (over: {
    before?: Partial<typeof base>;
    after?: Partial<typeof base>;
    actorId: number;
    deadlineChanged?: boolean;
  }) =>
    buildTodoNotices({
      before: { ...base, ...over.before },
      after: { ...base, ...over.after },
      actorId: over.actorId,
      deadlineChanged: over.deadlineChanged ?? false,
    });

  it('改派给他人时，新负责人与原负责人各收一条', () => {
    const notices = build({
      before: { assigneeUserId: 10 },
      after: { assigneeUserId: 11 },
      actorId: 99,
    });

    expect(notices).toEqual([
      {
        userId: 11,
        kind: 'todo_assigned',
        content: '你被指派了待办「整理会议纪要」',
      },
      {
        userId: 10,
        kind: 'todo_reassigned',
        content: '待办「整理会议纪要」已转交给他人，你不再需要跟进',
      },
    ]);
  });

  it('操作者把活甩给别人时，自己不该收到「已转交」', () => {
    const notices = build({
      before: { assigneeUserId: 10 },
      after: { assigneeUserId: 11 },
      actorId: 10,
    });

    expect(notices).toHaveLength(1);
    expect(notices[0].userId).toBe(11);
    expect(notices[0].kind).toBe('todo_assigned');
  });

  it('自己接手别人转出的活，自己不该收到「你被指派了」', () => {
    const notices = build({
      before: { assigneeUserId: 10 },
      after: { assigneeUserId: 99 },
      actorId: 99,
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ userId: 10, kind: 'todo_reassigned' });
  });

  it('取消指派时只通知原负责人', () => {
    const notices = build({
      before: { assigneeUserId: 10 },
      after: { assigneeUserId: null },
      actorId: 99,
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ userId: 10, kind: 'todo_reassigned' });
  });

  it('从无负责人指派给某人，只发新负责人那条', () => {
    const notices = build({
      before: { assigneeUserId: null },
      after: { assigneeUserId: 11 },
      actorId: 99,
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ userId: 11, kind: 'todo_assigned' });
  });

  it('换验收人只通知新验收人', () => {
    const notices = build({
      before: { reviewerId: 20 },
      after: { reviewerId: 21 },
      actorId: 99,
    });

    expect(notices).toEqual([
      {
        userId: 21,
        kind: 'todo_review_assigned',
        content: '你被指定为待办「整理会议纪要」的验收人',
      },
    ]);
  });

  it('改期通知当前负责人，并带上新截止时间', () => {
    const notices = build({
      before: { deadline: '下周一' },
      after: { deadline: '11月30日' },
      actorId: 99,
      deadlineChanged: true,
    });

    expect(notices).toEqual([
      {
        userId: 10,
        kind: 'todo_deadline_changed',
        content: '待办「整理会议纪要」截止时间改为 11月30日',
      },
    ]);
  });

  it('改期时负责人是操作者本人，不发通知', () => {
    expect(
      build({
        before: { deadline: '下周一' },
        after: { deadline: '11月30日' },
        actorId: 10,
        deadlineChanged: true,
      }),
    ).toEqual([]);
  });

  it('只改内容不触发任何通知', () => {
    expect(
      build({
        before: { content: '旧内容' },
        after: { content: '新内容' },
        actorId: 99,
      }),
    ).toEqual([]);
  });

  it('同时改派与改期，新负责人会收到两条互补的消息', () => {
    const notices = build({
      before: { assigneeUserId: 10, deadline: '下周一' },
      after: { assigneeUserId: 11, deadline: '11月30日' },
      actorId: 99,
      deadlineChanged: true,
    });

    expect(notices.map((n) => n.kind)).toEqual([
      'todo_assigned',
      'todo_reassigned',
      'todo_deadline_changed',
    ]);
    expect(notices.filter((n) => n.userId === 11)).toHaveLength(2);
  });
});
