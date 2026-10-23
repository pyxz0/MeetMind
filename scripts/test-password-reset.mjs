/**
 * 忘记密码流程端到端验证（只在本地库跑）。
 *
 * 覆盖：管理员发链接、链接校验、设置新密码、旧会话立即失效、
 * 令牌一次性、同级/越权拒绝、本人改自己走个人中心。
 */
const BASE = 'http://127.0.0.1:3100/api';

let passed = 0;
let failed = 0;

const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name} ${detail}`);
  }
};

const call = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { status: response.status, data };
};

const login = (phone, password) =>
  call('/auth/login', { method: 'POST', body: { phone, password } });

const ADMIN = { phone: '13900000081', password: 'Passw0rd!' };
const TARGET = { phone: '13900000082', password: 'Passw0rd!' };
const TARGET_ID = 83;
const ADMIN_ID = 82;

const run = async () => {
  const adminLogin = await login(ADMIN.phone, ADMIN.password);
  check('管理员登录', adminLogin.status === 200 || adminLogin.status === 201, JSON.stringify(adminLogin.data));
  const adminToken = adminLogin.data?.token;

  const targetLogin = await login(TARGET.phone, TARGET.password);
  check('目标用户登录', targetLogin.status === 200 || targetLogin.status === 201);
  const targetTokenBefore = targetLogin.data?.token;

  const meBefore = await call('/auth/me', { token: targetTokenBefore });
  check('重置前旧会话可用', meBefore.status === 200);

  const issue = await call(`/users/${TARGET_ID}/password-reset`, {
    method: 'POST',
    token: adminToken,
  });
  check('管理员生成重置链接', issue.status === 200 || issue.status === 201, JSON.stringify(issue.data));
  const resetToken = issue.data?.token;
  check('链接有效期 30 分钟', issue.data?.ttlMinutes === 30);

  const inspect = await call('/auth/password-reset/inspect', {
    method: 'POST',
    body: { token: resetToken },
  });
  check('链接校验返回本人信息', inspect.status === 200 || inspect.status === 201, JSON.stringify(inspect.data));
  check('手机号已脱敏', inspect.data?.phone === '139****0082', String(inspect.data?.phone));

  const weak = await call('/auth/password-reset/confirm', {
    method: 'POST',
    body: { token: resetToken, password: '12345678' },
  });
  check('弱密码被拒（缺字母）', weak.status === 400, JSON.stringify(weak.data));

  const confirm = await call('/auth/password-reset/confirm', {
    method: 'POST',
    body: { token: resetToken, password: 'NewPassw0rd!' },
  });
  check('设置新密码成功', confirm.status === 200 || confirm.status === 201, JSON.stringify(confirm.data));

  const meAfter = await call('/auth/me', { token: targetTokenBefore });
  check('重置后旧会话立即失效', meAfter.status === 401, String(meAfter.status));

  const reuse = await call('/auth/password-reset/inspect', {
    method: 'POST',
    body: { token: resetToken },
  });
  check('令牌一次性（不能重复使用）', reuse.status === 400, String(reuse.status));

  const oldPassword = await login(TARGET.phone, TARGET.password);
  check('旧密码不能登录', oldPassword.status === 401, String(oldPassword.status));

  const newPassword = await login(TARGET.phone, 'NewPassw0rd!');
  check('新密码可以登录', newPassword.status === 200 || newPassword.status === 201);
  const targetTokenAfter = newPassword.data?.token;

  const meNew = await call('/auth/me', { token: targetTokenAfter });
  check('新令牌可用', meNew.status === 200);

  const byUser = await call(`/users/${ADMIN_ID}/password-reset`, {
    method: 'POST',
    token: targetTokenAfter,
  });
  check('普通用户调重置接口被拒', byUser.status === 403, String(byUser.status));

  const self = await call(`/users/${ADMIN_ID}/password-reset`, {
    method: 'POST',
    token: adminToken,
  });
  check('不能给自己发重置链接（走个人中心）', self.status === 400, String(self.status));

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error('脚本异常：', error);
  process.exit(1);
});
