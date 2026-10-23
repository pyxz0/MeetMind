/**
 * 打点脚本的公共部分。
 *
 * 设计原则：
 * 1. 只做只读探测，绝不写数据、绝不打印完整密钥
 * 2. 任何一次调用都记录「HTTP 状态 + 业务错误码 + 耗时」，因为打点的结论
 *    往往不是"成功/失败"，而是"被哪个权限码挡住了"（例如飞书 99991672）
 * 3. 输出可以直接粘进 docs/platform-spike-report.md 的表格
 */

/** 保留首尾各 4 位，中间打码；非字符串原样返回 */
export const mask = (value) => {
  if (typeof value !== 'string') return value;
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)} (len=${value.length})`;
};

/** 发一次请求，永不抛异常：网络错误也当成一条可记录的结果 */
export async function requestJson(url, init = {}) {
  const started = Date.now();

  try {
    const res = await fetch(url, init);
    const text = await res.text();

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON（HTML 错误页、网关页）也要留下线索
      body = { _raw: text.slice(0, 300) };
    }

    return { ok: res.ok, status: res.status, body, ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { _error: String(error?.message ?? error) },
      ms: Date.now() - started,
    };
  }
}

/** 从各平台的响应体里抠出业务错误码 */
const extractCode = (body) => {
  if (!body || typeof body !== 'object') return '';
  const code = body.code ?? body.errcode ?? body.errCode ?? body.error_info?.code;
  return code === undefined || code === null ? '' : String(code);
};

/** 从响应体里抠出一句人话，用于快速判断是"没权限"还是"参数错" */
const extractMessage = (body) => {
  if (!body || typeof body !== 'object') return '';
  const msg =
    body.msg ??
    body.errmsg ??
    body.message ??
    body.error_info?.message ??
    body._error ??
    body._raw ??
    '';
  return String(msg).slice(0, 60);
};

export function createReport(platform) {
  const rows = [];
  let failed = 0;

  return {
    /** 记一条探测结果 */
    add(name, result, extra = {}) {
      const code = extractCode(result.body);
      const success = result.ok && (code === '' || code === '0');

      if (!success) failed += 1;

      rows.push({
        接口: name,
        HTTP: result.status,
        错误码: code,
        判定: success ? 'OK' : 'FAIL',
        耗时ms: result.ms,
        信息: extractMessage(result.body),
        ...extra,
      });

      return { success, code };
    },

    /** 打印一张可以直接贴进报告的表 */
    print() {
      // eslint-disable-next-line no-console
      console.log(`\n===== ${platform} 打点结果 =====`);
      // eslint-disable-next-line no-console
      console.table(rows);
      // eslint-disable-next-line no-console
      console.log(`失败 ${failed} / 共 ${rows.length} 项\n`);
      return rows;
    },

    get failedCount() {
      return failed;
    },
  };
}
