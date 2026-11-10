import { ElMessage } from 'element-plus'

/**
 * 一键入会。
 *
 * 腾讯会议的入会链接带一段随机 dm 串，没法从会议号拼出来；
 * 但客户端注册了自己的 scheme，会议号可以直接拼进去 ——
 * 这是「填了会议号真能一键进会」与「给人一个号码自己抄」的区别。
 *
 * 参考资料：wemeet://page/inmeeting?meeting_code=<9-11 位会议号>
 */
const WEMEET_SCHEME = (code: string) =>
  `wemeet://page/inmeeting?meeting_code=${code}`

export interface JoinableMeeting {
  externalCode?: string | null
  externalJoinUrl?: string | null
}

export interface JoinTarget {
  target: string
  /** 自定义协议需要探测是否真的拉起了客户端 */
  isScheme: boolean
}

export const buildJoinTarget = (
  meeting: JoinableMeeting
): JoinTarget | null => {
  if (meeting.externalJoinUrl) {
    return { target: meeting.externalJoinUrl, isScheme: false }
  }

  if (meeting.externalCode) {
    return { target: WEMEET_SCHEME(meeting.externalCode), isScheme: true }
  }

  return null
}

/** 会议号按 3-3-3 分组：「498 330 226」比「498330226」好念 */
export const formatJoinCode = (code: string): string =>
  code.replace(/(\d{3})(?=\d)/g, '$1 ').trim()

/** 只负责写剪贴板，提示交给调用方 —— 入会失败时不想弹两条 */
export const writeMeetingCode = async (
  code?: string | null
): Promise<boolean> => {
  if (!code) return false

  try {
    await navigator.clipboard.writeText(code)
    return true
  } catch {
    return false
  }
}

export const copyMeetingCode = async (code?: string | null) => {
  if (!code) return

  const ok = await writeMeetingCode(code)

  if (ok) {
    ElMessage.success('会议号已复制，打开腾讯会议输入即可')
  } else {
    ElMessage.warning(`复制失败，请手动输入：${code}`)
  }
}

/**
 * 打开入会。
 *
 * 自定义协议没有「是否拉起成功」的回调，只能间接判断：
 * 客户端被拉起时浏览器会失去焦点。给 2 秒窗口，
 * 期间没失焦就认为没装客户端，退回复制会议号 —— 总比点了没反应强。
 */
export const openMeeting = (meeting: JoinableMeeting): boolean => {
  const built = buildJoinTarget(meeting)

  if (!built) return false

  if (!built.isScheme) {
    // noopener 防止新页面拿到 window.opener
    window.open(built.target, '_blank', 'noopener')
    return true
  }

  let left = false
  const onLeave = () => {
    left = true
  }

  window.addEventListener('blur', onLeave, { once: true })
  window.location.href = built.target

  window.setTimeout(() => {
    window.removeEventListener('blur', onLeave)

    if (!left) {
      ElMessage.warning('没有打开腾讯会议？可能未安装客户端，会议号已复制')
      void writeMeetingCode(meeting.externalCode)
    }
  }, 2200)

  return true
}
