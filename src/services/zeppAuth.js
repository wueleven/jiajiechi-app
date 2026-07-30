/**
 * Zepp (华米 Amazfit 新版 App) 认证服务 - 技术验证阶段
 *
 * 参考: github.com/zepp-health/rest-api（官方 REST API 文档）
 *      github.com/argrento/huami-token（非官方 Zepp 登录实现，MIT）
 *
 * 登录流程:
 *   1) POST api-user-us2.zepp.com/v2/registrations/tokens
 *      - 加密 payload (AES-256-CBC) 含 emailOrPhone + password
 *      - 返回 303 重定向，Location 带 access/refresh token
 *   2) POST api-mifit-us2.zepp.com/v2/client/login
 *      - 用 access_token 换 app_token + user_id
 *
 * 注意:
 *   - 登录第一步/第二步都发原生 fetch（不经 CapacitorHttp，避免二进制 body 被 base64）
 *   - 开发模式(Web)通过 Vite 代理 /__proxy__/ 绕 CORS；原生 WebView 无 CORS 限制
 */

import { Capacitor } from '@capacitor/core'
import { encryptPassword, decryptPassword } from '../utils/crypto.js'
import { getUserData, saveUserData } from './storage.js'

console.log('[Zepp] zeppAuth loaded v3 (opaque-303 + cn-only)')
// Zepp 私有常量（来自 huami-token 逆向，与官方客户端一致）
const ZEPP_ENC_KEY = 'xeNtBVqzDc6tuNTh'
const ZEPP_ENC_IV = 'MAAAYAAAAAAAAABg'

// Zepp 登录节点与参数 —— 严格对齐 huami-token 官方实现
// 重要: tokens 接口所有账号(含中国区)都用 us2 节点 + region=us-west-2，
// 不能改成 cn（否则华米返回 401/400）。账号国家区分由华米内部处理。
const ZEPP_TOKENS_NODES = [
  { url: 'https://api-user-us2.zepp.com/v2/registrations/tokens', region: 'us-west-2', country: 'US' },
]
const ZEPP_LOGIN_NODES = {
  us2: 'https://api-mifit-us2.zepp.com/v2/client/login',
}
const ZEPP_DEVICES_URL = 'https://api-mifit.zepp.com/users/{user_id}/devices'
const ZEPP_SPORTS_URL = 'https://api-mifit.zepp.com/users/{user_id}/sports'

const ZEPP_CHANNEL = 'a100900101016'
const PROXY_PREFIX = '/__proxy__/'

// 开发模式把外部 URL 改写为 Vite 代理路径，绕开 CORS
function rewriteUrl(url) {
  if (Capacitor.isNativePlatform() || !import.meta.env.DEV) return url
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return url
    return `${PROXY_PREFIX}${parsed.host}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

// ============ 加密 (AES-256-CBC, PKCS7) ============

async function zeppEncrypt(plainUrlEncoded) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(ZEPP_ENC_KEY),
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  )
  const iv = enc.encode(ZEPP_ENC_IV)
  // 注意: Web Crypto 的 AES-CBC 会自动做 PKCS7 padding，
  // 直接传原始明文即可，不要手动 pad（否则双重 padding 导致服务端解密失败→403）
  const data = enc.encode(plainUrlEncoded)
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, data)
  return new Uint8Array(cipherBuf)
}

// 原生 fetch 发送。
// 原生模式: redirect:'manual'，直接读 303 的 location header（WebView 能读到）。
// 开发模式: 走 Vite 代理，用 redirect:'follow'；代理会把 303 改写为 200+JSON{location} 返回。
async function zeppFetch(url, { method = 'POST', headers = {}, body = null } = {}) {
  const fetchUrl = rewriteUrl(url)
  const redirectMode = Capacitor.isNativePlatform() ? 'manual' : 'follow'
  const res = await fetch(fetchUrl, { method, headers, body, redirect: redirectMode })
  return res
}

// ============ 登录 ============

async function getTokens(username, password) {
  const headers = {
    'app_name': 'com.huami.midong',
    'appname': 'com.huami.midong',
    'cv': '151689_9.12.5',
    'v': '2.0',
    'appplatform': 'android_phone',
    'vb': '202509151347',
    'vn': '9.12.5',
    'user-agent': 'Zepp/9.12.5 (Pixel 4; Android 12; Density/2.75)',
    'x-hm-ekv': '1',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'accept-encoding': 'gzip',
  }

  // 各区域节点用各自匹配的 region/country 参数（错配会返回 HTTP 400）
  const nodeStatus = []
  for (const node of ZEPP_TOKENS_NODES) {
    const payload = [
      'emailOrPhone=' + encodeURIComponent(username),
      'state=REDIRECTION',
      'client_id=HuaMi',
      'password=' + encodeURIComponent(password),
      'redirect_uri=' + encodeURIComponent('https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html'),
      'region=' + node.region,
      'token=access',
      'token=refresh',
      'country_code=' + node.country,
    ].join('&')

    const body = await zeppEncrypt(payload)
    // 调试：确认发出的账号格式与加密体大小（不打印密码）
    console.log(`[Zepp] 发送账号字段 emailOrPhone=${encodeURIComponent(username)}, 加密体字节=${body.length}`)

    try {
      const res = await zeppFetch(node.url, { method: 'POST', headers, body })
      console.log(`[Zepp] ${node.region} -> HTTP ${res.status}, content-type=${res.headers.get('content-type')}`)
      // 原生模式(manual): 读 303 的 location header
      // 开发模式(走代理, follow): 代理已把 303 改写为 200 + JSON{location}
      let location = ''
      try {
        const text = await res.text()
        console.log(`[Zepp] raw body(${text.length}): ${text.slice(0, 200)}`)
        try {
          const j = JSON.parse(text)
          if (j && j.location) location = j.location
        } catch { /* 非 JSON */ }
      } catch {
        location = res.headers.get('location') || ''
      }
      nodeStatus.push(`${node.region}:HTTP ${res.status}`)
      if (location) {
        // 华米在账号/密码不正确时，location 里带 error=401 且无 access/refresh token
        if (location.includes('error=401') || location.includes('error=400')) {
          throw new Error('账号或密码错误（华米返回 401），请核对后在官方 App 能登录的账号密码')
        }
        const u = new URL(location)
        const access = u.searchParams.get('access')
        const refresh = u.searchParams.get('refresh')
        if (access && refresh) return { access, refresh, region: 'us2' }
      }
    } catch (e) {
      console.log(`[Zepp] ${node.region} -> 异常: ${e.message}`)
      nodeStatus.push(`${node.region}:ERR ${e.message}`)
    }
  }
  throw new Error(`Zepp 登录失败(各节点: ${nodeStatus.join(', ')})`)
}

async function loginWithToken(accessToken, region = 'us2') {
  const loginUrl = ZEPP_LOGIN_NODES[region] || ZEPP_LOGIN_NODES.us2
  const payload = [
    'code=' + encodeURIComponent(accessToken),
    'device_id=' + crypto.randomUUID(),
    'device_model=android_phone',
    'app_version=9.12.5',
    'dn=' + encodeURIComponent('api-mifit.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,auth.zepp.com,api-analytics.zepp.com'),
    'third_name=huami',
    'source=com.huami.watch.hmwatchmanager:9.12.5:151689',
    'app_name=com.huami.midong',
    'country_code=US',
    'grant_type=access_token',
    'allow_registration=false',
    'lang=en',
    'countryState=US-NY',
  ].join('&')

  const headers = {
    'app_name': 'com.huami.webapp',
    'appname': 'com.huami.webapp',
    'origin': 'https://user.zepp.com',
    'referer': 'https://user.zepp.com/',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.5',
  }

  const res = await zeppFetch(loginUrl, { method: 'POST', headers, body: payload, redirect: 'follow' })
  const data = await res.json()
  const tokenInfo = data.token_info || {}
  if (!tokenInfo.app_token || !tokenInfo.user_id) {
    throw new Error('Zepp 登录失败: 未获取到 app_token/user_id')
  }
  return {
    appToken: tokenInfo.app_token,
    userId: String(tokenInfo.user_id),
    loginToken: tokenInfo.login_token || '',
  }
}

export async function zeppLogin(username, password) {
  const { access, refresh, region } = await getTokens(username, password)
  const { appToken, userId, loginToken } = await loginWithToken(access, region)
  return { appToken, userId, access, refresh, loginToken, region }
}

// ============ 验证阶段: 拉数据 ============

async function zeppApiGet(url, appToken, userId, extraParams = {}, region = 'us2') {
  const params = new URLSearchParams({
    userid: userId,
    appid: String(Math.floor(Math.random() * 1e19)),
    channel: ZEPP_CHANNEL,
    country: 'US',
    cv: '151689_9.12.5',
    device: 'android_32',
    device_type: 'android_phone',
    lang: 'en_US',
    timezone: 'Europe/London',
    v: '2.0',
    ...extraParams,
  })
  const headers = {
    'appplatform': 'android_phone',
    'channel': ZEPP_CHANNEL,
    'cv': '151689_9.12.5',
    'appname': 'com.huami.midong',
    'v': '2.0',
    'vn': '9.12.5',
    'apptoken': appToken,
    'lang': 'en_US',
    'user-agent': 'Zepp/9.12.5 (Pixel 4; Android 12; Density/2.75)',
  }
  const res = await zeppFetch(`${url}?${params.toString()}`, { method: 'GET', headers, redirect: 'follow' })
  return res.json()
}

export async function getZeppDevices(appToken, userId, region = 'us2') {
  const url = ZEPP_DEVICES_URL.replace('{user_id}', userId)
  return zeppApiGet(url, appToken, userId, { r: crypto.randomUUID(), r: crypto.randomUUID(), enableMultiDevice: 'true' }, region)
}

export async function getZeppSports(appToken, userId, startDate, endDate, region = 'us2') {
  const url = ZEPP_SPORTS_URL.replace('{user_id}', userId)
  const today = new Date()
  const end = endDate || today.toISOString().slice(0, 10)
  const start = startDate || new Date(today.getTime() - 30 * 864e5).toISOString().slice(0, 10)
  return zeppApiGet(url, appToken, userId, { startDate: start, endDate: end }, region)
}

// ============ 本地存储（密文，与佳明/高驰一致） ============

export function saveZeppBind(username, password, auth) {
  const encPassword = encryptPassword(password)
  const encAppToken = encryptPassword(auth.appToken)
  const encAccess = encryptPassword(auth.access)
  const encRefresh = encryptPassword(auth.refresh)

  const userData = getUserData()
  userData.zepp = {
    bound: true,
    username,
    encPassword,
    appToken: encAppToken,
    access: encAccess,
    refresh: encRefresh,
    userId: auth.userId,
    region: auth.region || 'us2',
    displayName: username,
    boundAt: new Date().toISOString(),
  }
  saveUserData(userData)
  return userData
}

export function loadZeppCredentials() {
  const userData = getUserData()
  const z = userData.zepp
  if (!z || !z.bound) return null
  try {
    return {
      username: z.username,
      password: decryptPassword(z.encPassword),
      appToken: decryptPassword(z.appToken),
      access: decryptPassword(z.access),
      refresh: decryptPassword(z.refresh),
      userId: z.userId,
    }
  } catch {
    return null
  }
}

export function clearZeppBind() {
  const userData = getUserData()
  delete userData.zepp
  saveUserData(userData)
}
