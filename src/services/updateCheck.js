/**
 * 检查更新服务
 * 主源：Gitee 公开仓库 raw 的 version.json（国内直连稳定）
 * 备源：GitHub Releases API（Gitee 不可达时兜底）
 * 两个源都失败时明确报"连不上更新服务器"，绝不把失败当成"已是最新版本"
 */
import { httpRequest } from './http.js'

// ===== 发布渠道配置（换托管地址只改这里） =====
const GITEE_OWNER = 'iteleven11'
const GITEE_REPO = 'jiajiechi-app'
const GITEE_VERSION_URL = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/raw/master/version.json`
const GITHUB_LATEST_API = 'https://api.github.com/repos/wueleven/jiajiechi-app/releases/latest'
const GITHUB_RELEASE_BASE = 'https://github.com/wueleven/jiajiechi-app/releases/tag/'

/**
 * 版本号比较：a > b 返回 1，a < b 返回 -1，相等返回 0
 * 支持 "v0.9.8-beta.4" / "0.9.8" 格式；正式版大于同号码的 beta 版
 */
export function compareVersion(a, b) {
  const parse = (v) => {
    const m = String(v || '').replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?/)
    if (!m) return null
    return { core: [Number(m[1]), Number(m[2]), Number(m[3])], beta: m[4] ? Number(m[4]) : Infinity }
  }
  const pa = parse(a), pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1
  }
  if (pa.beta === pb.beta) return 0
  return pa.beta > pb.beta ? 1 : -1
}

/** 从 Gitee version.json 获取最新版本信息 */
async function fetchFromGitee() {
  const res = await httpRequest(GITEE_VERSION_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    responseType: 'json',
    validateStatus: false,
    timeout: 10000,
  })
  if (res.status !== 200) throw new Error(`Gitee HTTP ${res.status}`)
  // Gitee raw 在异常时可能返回 HTML（登录页/风控页），JSON 解析失败同样视为该源不可用
  const info = typeof res.data === 'object' ? res.data : JSON.parse(res.data)
  if (!info?.versionName) throw new Error('Gitee version.json 缺少 versionName')
  // downloadUrls: [{label, url}] 多下载源（如蒲公英/GitHub）；兼容单一 downloadUrl 字段
  const downloadUrls = Array.isArray(info.downloadUrls) && info.downloadUrls.length
    ? info.downloadUrls.filter(d => d?.url)
    : [{ label: '去下载', url: info.downloadUrl || `${GITHUB_RELEASE_BASE}${info.versionName}` }]
  return {
    versionName: info.versionName,
    versionCode: Number(info.versionCode) || 0,
    notes: info.notes || '',
    downloadUrls,
    source: 'gitee',
  }
}

/** 从 GitHub Releases API 获取最新版本信息（备源） */
async function fetchFromGithub() {
  const res = await httpRequest(GITHUB_LATEST_API, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json' },
    responseType: 'json',
    validateStatus: false,
    timeout: 10000,
  })
  if (res.status !== 200) throw new Error(`GitHub HTTP ${res.status}`)
  const info = typeof res.data === 'object' ? res.data : JSON.parse(res.data)
  if (!info?.tag_name) throw new Error('GitHub release 缺少 tag_name')
  return {
    versionName: info.tag_name,
    versionCode: 0, // release API 不提供 versionCode，只按版本名比较
    notes: info.body || '',
    downloadUrls: [{ label: '从 GitHub 下载', url: info.html_url }],
    source: 'github',
  }
}

/**
 * 检查更新
 * @param {{ versionName: string, versionCode: number }} current 当前版本（App.getInfo 的 version/build）
 * @returns {{ hasUpdate: boolean, latest?: object, current: object }}
 * @throws 两个源都不可达时抛出网络错误（message 含"连不上"）
 */
export async function checkForUpdate(current) {
  const errors = []
  let latest = null
  for (const fetcher of [fetchFromGitee, fetchFromGithub]) {
    try {
      latest = await fetcher()
      break
    } catch (e) {
      errors.push(e.message || String(e))
    }
  }
  if (!latest) {
    throw new Error(`连不上更新服务器（${errors.join('；')}），请检查网络后重试`)
  }
  // 优先用 versionCode（Android build 号）比较，取不到时回退版本名比较
  const hasUpdate = latest.versionCode && current.versionCode
    ? latest.versionCode > current.versionCode
    : compareVersion(latest.versionName, current.versionName) > 0
  return { hasUpdate, latest, current }
}
