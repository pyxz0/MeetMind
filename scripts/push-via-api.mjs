// 为什么存在这个脚本
// 本机到 github.com:443 直连被重置、代理返回 502，git push 走不通；
// 但 api.github.com 可访问，于是用 Git Data API 逐个复现本地提交。
// 因为复现出的 commit sha 与本地完全一致，远端是干净的快进，不需要 force。
//
// 用法：
//   GH_TOKEN=<有 repo 权限的 token> COMMITS="<sha1> <sha2> ..." node scripts/push-via-api.mjs
//   （GH_TOKEN 只用环境变量传，不落盘）

// 用 GitHub Git Data API 逐个复现本地提交（内容、作者、时间完全一致）
// 目标：远端产生的 commit sha 与本地一致，这样 push 就不需要 force
import { execSync } from 'node:child_process'

const TOKEN = process.env.GH_TOKEN

if (!TOKEN) throw new Error('缺少 GH_TOKEN')
const OWNER = 'pyxz0'
const REPO = 'MeetMind'
const API = 'https://api.github.com'

const sh = (cmd) => execSync(cmd, { maxBuffer: 64 * 1024 * 1024 }).toString()

const api = async (path, method = 'GET', body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'meetmind-sync',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }

  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  }

  return data
}

/** 解析 commit 对象里的 author / committer 行 */
const parsePerson = (line) => {
  // author Name <mail> 1698234567 +0800
  const m = line.match(/^(\w+) (.*) <(.*)> (\d+) ([+-]\d{4})$/)
  if (!m) throw new Error(`无法解析身份行: ${line}`)

  const [, , name, email, ts, tz] = m
  const offset = `${tz.slice(0, 3)}:${tz.slice(3)}`
  const iso = new Date(Number(ts) * 1000).toISOString().replace('Z', '')
  // 用原时区拼回 ISO：先按 UTC 取到本地墙钟，再补偏移
  const local = new Date((Number(ts) + (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 3600 + Number(tz.slice(3)) * 60)) * 1000)
    .toISOString()
    .replace('Z', '')
  return { name, email, date: `${local}${offset}`, iso }
}

const pushCommit = async (sha, parentTreeOverride) => {
  const raw = sh(`git cat-file commit ${sha}`)
  const splitAt = raw.indexOf('\n\n')
  const head = raw.slice(0, splitAt)
  const message = raw.slice(splitAt + 2)

  const lines = head.split('\n')
  const parentLine = lines.find((l) => l.startsWith('parent '))
  const parent = parentLine ? parentLine.slice(7).trim() : null
  const authorLine = lines.find((l) => l.startsWith('author '))
  const committerLine = lines.find((l) => l.startsWith('committer '))

  if (!parent) throw new Error(`${sha} 没有父提交`)

  const author = parsePerson(authorLine)
  const committer = parsePerson(committerLine)

  // 变更清单（不用 rename 检测，统一按 D + A 处理）
  const status = sh(`git diff-tree -r --no-renames --name-status ${parent} ${sha}`)
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [code, ...paths] = row.split('\t')
      return { code: code[0], path: paths.join('\t') }
    })

  const entries = []

  for (const item of status) {
    if (item.code === 'D') {
      entries.push({ path: item.path, mode: '100644', type: 'blob', sha: null })
      continue
    }

    const blobSha = sh(`git rev-parse ${sha}:${item.path}`).trim()
    const content = execSync(`git cat-file blob ${blobSha}`, { maxBuffer: 64 * 1024 * 1024 })
    const mode = sh(`git ls-tree ${sha} -- "${item.path}"`).split(' ')[0]

    const created = await api(`/repos/${OWNER}/${REPO}/git/blobs`, 'POST', {
      content: content.toString('base64'),
      encoding: 'base64',
    })

    if (created.sha !== blobSha) {
      console.log(`  ! blob 不一致 ${item.path}: local=${blobSha.slice(0, 8)} remote=${created.sha.slice(0, 8)}`)
    }

    entries.push({ path: item.path, mode: mode || '100644', type: 'blob', sha: created.sha })
  }

  const baseTree = parentTreeOverride ?? sh(`git rev-parse "${parent}^{tree}"`).trim()

  const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, 'POST', {
    base_tree: baseTree,
    tree: entries,
  })

  const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, 'POST', {
    message,
    tree: tree.sha,
    parents: [parent],
    author: { name: author.name, email: author.email, date: author.date },
    committer: { name: committer.name, email: committer.email, date: committer.date },
  })

  return { remoteSha: commit.sha, treeSha: tree.sha, localSha: sha, entries: entries.length }
}

const only = process.argv[2]
const list = (process.env.COMMITS ?? only ?? '').split(/\s+/).filter(Boolean)

let parentTree = null

for (const sha of list) {
  const result = await pushCommit(sha, parentTree)
  parentTree = result.treeSha

  const match = result.remoteSha === result.localSha
  console.log(`${match ? '✓' : '✗'} ${sha.slice(0, 8)} → ${result.remoteSha.slice(0, 8)}  文件 ${result.entries}`)
  if (!match) {
    console.log(`  local=${result.localSha}`)
    console.log(`  remote=${result.remoteSha}`)
    process.exit(2)
  }
}

console.log(`\n最后一个提交：${list[list.length - 1]}`)
