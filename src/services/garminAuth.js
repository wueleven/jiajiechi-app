/**
 * Garmin 认证服务 - 从 garminAuth 云函数迁移
 * 支持 SSO 登录、MFA 二步验证、OAuth1/OAuth2 token 交换
 */
import { httpRequest, qsStringify, qsParse, getCookiesForUrl, clearCookies, clearNativeCookies } from './http.js'
import { createOAuthClient } from '../utils/oauth1.js'
import { encryptPassword, decryptPassword } from '../utils/crypto.js'
import {
  getUserData, saveUserData, updatePlatformData,
  saveMfaState, getMfaState, clearMfaState,
} from './storage.js'

const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'

// 正则
const CSRF_RE = /name="_csrf"\s+value="(.+?)"/
const TICKET_RE = /ticket=([^"&]+)/
const MFA_RE = /mfa|two[- ]?factor|verification\s*code|验证码/i
const MFA_EXEC_RE = /name="execution"\s+value="([^"]+)"/

// ============ SSO URL 构建 ============

function getSsoUrls(region) {
  const domain = region === 'cn' ? 'garmin.cn' : 'garmin.com'
  const ssoOrigin = `https://sso.${domain}`
  const gcModern = `https://connect.${domain}/modern`
  const apiDomain = `https://connectapi.${domain}`
  return {
    ssoOrigin,
    ssoEmbed: `${ssoOrigin}/sso/embed`,
    signinUrl: `${ssoOrigin}/sso/signin`,
    loginUrl: `${ssoOrigin}/sso/login`,
    gcModern,
    oauthUrl: `${apiDomain}/oauth-service/oauth`,
    apiBase: apiDomain,
  }
}

// ============ Cookie 会话管理 ============

/**
 * 为 Garmin 域名设置 cookies
 */
function setCookiesForDomain(domain, cookieStr) {
  // 通过 http.js 的 cookieStore 管理
  // 这里解析并存储
  if (!cookieStr) return
  cookieStr.split('; ').forEach(c => {
    const nameValue = c.trim()
    if (nameValue) {
      const url = `https://sso.${domain}`
      // 手动添加到 cookie store
      const [name] = nameValue.split('=')
      // 使用 http.js 的内部方法
    }
  })
}

// ============ 登录步骤 ============

/**
 * 第一步：提交账号密码
 * @returns { ticket | mfaRequired, execution, cookieStr, urls, mfaEndpoint }
 */
export async function loginStep1(username, password, region) {
  const urls = getSsoUrls(region)
  const domain = region === 'cn' ? 'garmin.cn' : 'garmin.com'

  // 清空该域名的 cookies（JS 侧 + 原生 CookieManager，避免上次尝试的旧会话污染登录流程）
  clearCookies(`sso.${domain}`)
  clearCookies(`connect.${domain}`)
  await clearNativeCookies(`https://sso.${domain}`)
  await clearNativeCookies(`https://connect.${domain}`)

  const baseHeaders = {
    'User-Agent': USER_AGENT,
  }

  console.log(`[Garmin ${region}] Step 0: ssoEmbed = ${urls.ssoEmbed}`)

  // Step 1: 设置初始 cookies
  const step1Res = await httpRequest(urls.ssoEmbed, {
    method: 'GET',
    headers: baseHeaders,
    responseType: 'text',
    validateStatus: false,
    timeout: 15000,
  })
  console.log(`[Garmin ${region}] Step 1 status: ${step1Res.status}, url: ${step1Res.url}`)

  // Step 2: 获取 CSRF token
  const step2Url = `${urls.signinUrl}?${qsStringify({
    id: 'gauth-widget',
    embedWidget: 'true',
    locale: 'en',
    gauthHost: urls.ssoEmbed,
  })}`

  console.log(`[Garmin ${region}] Step 2: GET ${step2Url}`)
  const step2Res = await httpRequest(step2Url, {
    method: 'GET',
    headers: baseHeaders,
    responseType: 'text',
    validateStatus: false,
    timeout: 15000,
  })
  console.log(`[Garmin ${region}] Step 2 status: ${step2Res.status}`)

  const pageHtml = step2Res.data || ''
  const csrfMatch = CSRF_RE.exec(pageHtml)
  if (!csrfMatch) {
    console.error(`[Garmin ${region}] CSRF token not found. HTML preview:`, pageHtml.substring(0, 500))
    throw new Error('CSRF token not found')
  }
  const csrfToken = csrfMatch[1]
  console.log(`[Garmin ${region}] CSRF token: ${csrfToken.substring(0, 8)}...`)

  // Step 3: 提交登录
  const signinParams = {
    id: 'gauth-widget',
    embedWidget: 'true',
    clientId: 'GarminConnect',
    locale: 'en',
    gauthHost: urls.ssoEmbed,
    service: urls.ssoEmbed,
    source: urls.ssoEmbed,
    redirectAfterAccountLoginUrl: urls.ssoEmbed,
    redirectAfterAccountCreationUrl: urls.ssoEmbed,
  }
  const step3Url = `${urls.signinUrl}?${qsStringify(signinParams)}`

  const loginData = qsStringify({
    username,
    password,
    embed: 'true',
    _csrf: csrfToken,
  })

  console.log(`[Garmin ${region}] Step 3: POST ${step3Url}`)
  const step3Res = await httpRequest(step3Url, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': urls.ssoOrigin,
      'Referer': urls.signinUrl,
      'Dnt': '1',
    },
    body: loginData,
    followRedirect: false, // 关键：不跟随重定向，手动处理
    responseType: 'text',
    validateStatus: false,
    timeout: 30000,
  })

  console.log(`[Garmin ${region}] Step 3 status: ${step3Res.status}`)
  console.log(`[Garmin ${region}] Step 3 location: ${step3Res.headers['location'] || '(none)'}`)

  const html = step3Res.data || ''
  const location = step3Res.headers['location'] || ''

  // 302 重定向：可能包含 ticket 或 MFA
  if (step3Res.status === 302 || step3Res.status === 301) {
    if (location.includes('ticket=')) {
      const url = new URL(location, urls.ssoOrigin)
      const ticket = url.searchParams.get('ticket')
      if (ticket) return { ticket, urls }
    }

    // 跟随重定向查看目标页面
    if (location) {
      const redirectUrl = location.startsWith('http') ? location : `${urls.ssoOrigin}${location}`

      // 检查是否是 MFA URL
      if (/mfa|verifyMFA|enterMfaCode/i.test(redirectUrl)) {
        const mfaPageRes = await httpRequest(redirectUrl, {
          method: 'GET',
          headers: baseHeaders,
          responseType: 'text',
          validateStatus: false,
          timeout: 15000,
        })
        const mfaHtml = mfaPageRes.data || ''
        // 尝试多种正则提取 execution token（与云函数实现一致）
        let execution = ''
        const execPatterns = [
          /name="execution"\s+value="([^"]+)"/,
          /name=['"]execution['"]\s+value=['"]([^'"]+)['"]/,
          /value="([^"]+)"\s+name="execution"/,
          /id="execution"\s+value="([^"]+)"/,
          /execution['":\s]+['"]([^'"]{20,})['"]/,
        ]
        for (const pat of execPatterns) {
          const m = pat.exec(mfaHtml)
          if (m) { execution = m[1]; break }
        }
        console.log(`[Garmin ${region}] MFA detected from redirect URL, execution: ${execution ? 'found' : 'not found'}`)
        return {
          mfaRequired: true,
          execution,
          cookieStr: getCookiesForUrl(`https://sso.${domain}`),
          urls,
          mfaEndpoint: redirectUrl,
        }
      }

      // 普通重定向，跟随
      const redirectRes = await httpRequest(redirectUrl, {
        method: 'GET',
        headers: baseHeaders,
        responseType: 'text',
        validateStatus: false,
        timeout: 15000,
      })

      const redirectHtml = redirectRes.data || ''
      const redirectTicket = TICKET_RE.exec(redirectHtml)
      if (redirectTicket) {
        return { ticket: redirectTicket[1], urls }
      }

      const redirectLocation = redirectRes.headers['location'] || ''
      if (redirectLocation.includes('ticket=')) {
        const url = new URL(redirectLocation, urls.ssoOrigin)
        return { ticket: url.searchParams.get('ticket'), urls }
      }

      // 检查 MFA
      if (MFA_RE.test(redirectHtml) && !TICKET_RE.test(redirectHtml)) {
        const mfaExecMatch = MFA_EXEC_RE.exec(redirectHtml)
        const formActionMatch = /<form[^>]+action="([^"]+)"/i.exec(redirectHtml)
        const mfaFormAction = formActionMatch ? formActionMatch[1] : ''
        const mfaEndpoint = mfaFormAction
          ? (mfaFormAction.startsWith('http') ? mfaFormAction : `${urls.ssoOrigin}${mfaFormAction}`)
          : redirectUrl
        return {
          mfaRequired: true,
          execution: mfaExecMatch ? mfaExecMatch[1] : '',
          cookieStr: getCookiesForUrl(`https://sso.${domain}`),
          urls,
          mfaEndpoint,
        }
      }
    }
    throw new Error('Login failed: Redirect without ticket')
  }

  // 401 认证失败
  if (step3Res.status === 401) {
    console.error(`[Garmin ${region}] 401 response. HTML preview:`, html.substring(0, 800))
    throw new Error('账号或密码错误')
  }

  // 检查 MFA（HTML 中检测）
  // 浏览器 fetch 自动跟随重定向，step3Res 可能是 200 + MFA 页面 HTML；
  // 原生 disableRedirects 模式下 step3Res 是 302 + 登录页 HTML（含 MFA 提示）。
  if (MFA_RE.test(html) && !TICKET_RE.test(html)) {
    console.log(`[Garmin ${region}] MFA detected from HTML`)

    // 判断当前 HTML 是否已经是 MFA 页面（浏览器跟随重定向后的最终 URL 包含 MFA 路径）
    const finalUrl = step3Res.url || ''
    const isAlreadyMfaPage = /mfa|verifyMFA|enterMfaCode/i.test(finalUrl)

    let mfaHtml = html
    let mfaPageUrl = finalUrl

    if (!isAlreadyMfaPage) {
      // 当前 HTML 不是 MFA 页面（原生 302 分支或登录页含 MFA 提示），主动 GET MFA 页面提取 execution
      const mfaPageRes = await httpRequest(`${urls.ssoOrigin}/sso/verifyMFA/loginEnterMfaCode`, {
        method: 'GET',
        headers: baseHeaders,
        responseType: 'text',
        validateStatus: false,
        timeout: 15000,
      })
      mfaHtml = mfaPageRes.data || ''
      mfaPageUrl = mfaPageRes.url || ''
      console.log(`[Garmin ${region}] fetched MFA page, length=${mfaHtml.length}`)
    }

    // 多种正则提取 execution token（与云函数一致）
    let execution = ''
    const execPatterns = [
      /name="execution"\s+value="([^"]+)"/,
      /name=['"]execution['"]\s+value=['"]([^'"]+)['"]/,
      /value="([^"]+)"\s+name="execution"/,
      /id="execution"\s+value="([^"]+)"/,
      /execution['":\s]+['"]([^'"]{20,})['"]/,
      // 国服 MFA 页面可能的变体
      /name="lt"\s+value="([^"]+)"/,
      /name="_eventId"\s+value="([^"]+)"/,
      /<input[^>]+name="execution"[^>]+value="([^"]+)"/i,
      /<input[^>]+value="([^"]+)"[^>]+name="execution"/i,
    ]
    for (const pat of execPatterns) {
      const m = pat.exec(mfaHtml)
      if (m) { execution = m[1]; break }
    }
    console.log(`[Garmin ${region}] execution: ${execution ? 'found (len=' + execution.length + ')' : 'not found'}`)

    // 国服 MFA 页面使用 _csrf 做会话标识（不是 execution），同时带 fromPage=setupEnterMfaCode
    const csrfMatch = /name="_csrf"\s+value="([^"]+)"/i.exec(mfaHtml)
    const csrfToken = csrfMatch ? csrfMatch[1] : ''
    const fromPageMatch = /name="fromPage"\s+value="([^"]+)"/i.exec(mfaHtml)
    const fromPage = fromPageMatch ? fromPageMatch[1] : 'setupEnterMfaCode'
    console.log(`[Garmin ${region}] _csrf: ${csrfToken ? 'found (len=' + csrfToken.length + ')' : 'not found'}, fromPage: ${fromPage || '(none)'}`)

    // 提取 MFA 表单的 form action（可能带 execution 等参数）
    const formActionMatch = /<form[^>]+action="([^"]+)"/i.exec(mfaHtml)
    const mfaFormAction = formActionMatch ? formActionMatch[1] : ''
    let mfaEndpoint = mfaFormAction
      ? (mfaFormAction.startsWith('http') ? mfaFormAction : `${urls.ssoOrigin}${mfaFormAction}`)
      : `${urls.ssoOrigin}/sso/verifyMFA/loginEnterMfaCode`

    // 如果当前 HTML 已经是 MFA 页面，优先用响应 URL 作为 mfaEndpoint（保留原始查询参数）
    if (isAlreadyMfaPage && mfaPageUrl.includes('verifyMFA')) {
      mfaEndpoint = mfaPageUrl
    }

    return {
      mfaRequired: true,
      execution,
      csrfToken,
      fromPage,
      cookieStr: getCookiesForUrl(`https://sso.${domain}`),
      urls,
      mfaEndpoint,
    }
  }

  // 直接提取 ticket
  const ticketMatch = TICKET_RE.exec(html)
  if (ticketMatch) {
    console.log(`[Garmin ${region}] Ticket found in HTML`)
    return { ticket: ticketMatch[1], urls }
  }

  console.error(`[Garmin ${region}] No ticket found. Status: ${step3Res.status}. HTML preview:`, html.substring(0, 1000))
  throw new Error('Login failed: No ticket found')
}

/**
 * 第二步：提交 MFA 验证码
 * @param {Object} mfaState - loginStep1 返回的 MFA 中间状态（含 execution/csrfToken/fromPage/cookieStr/urls/mfaEndpoint）
 * @param {string} mfaCode - 用户输入的验证码
 */
export async function loginStep2Mfa(mfaState, mfaCode) {
  const urls = mfaState.urls
  const domain = urls.ssoOrigin.includes('garmin.cn') ? 'cn' : 'com'

  const mfaSubmitUrl = mfaState.mfaEndpoint || `${urls.ssoOrigin}/sso/verifyMFA/loginEnterMfaCode`

  // 国服 MFA 页面用 _csrf 做会话标识；国际服/老版本用 execution
  // 两者都带时两个都发，服务器会忽略不认识的字段
  const formFields = {
    'mfa-code': mfaCode,
    embed: 'true',
  }
  if (mfaState.csrfToken) formFields._csrf = mfaState.csrfToken
  if (mfaState.fromPage) formFields.fromPage = mfaState.fromPage
  if (mfaState.execution) formFields.execution = mfaState.execution
  if (!mfaState.csrfToken && !mfaState.execution) formFields._eventId = 'submit'

  const formData = qsStringify(formFields)
  console.log(`[Garmin MFA] submit fields: ${Object.keys(formFields).join(',')}`)

  const mfaQueryParams = {
    id: 'gauth-widget',
    embedWidget: 'true',
    clientId: 'GarminConnect',
    locale: 'en',
    gauthHost: urls.ssoEmbed,
    service: urls.gcModern,
  }

  // mfaEndpoint 可能自带查询参数（来自 302 重定向 URL），避免拼出两个 "?"
  const joinChar = mfaSubmitUrl.includes('?') ? '&' : '?'
  const res = await httpRequest(`${mfaSubmitUrl}${joinChar}${qsStringify(mfaQueryParams)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': urls.ssoOrigin,
      'Referer': mfaSubmitUrl,
      'User-Agent': USER_AGENT,
      ...(mfaState.cookieStr ? { 'Cookie': mfaState.cookieStr } : {}),
    },
    body: formData,
    followRedirect: false,
    responseType: 'text',
    validateStatus: false,
    timeout: 30000,
  })

  const html = res.data || ''
  const location = res.headers['location'] || ''
  console.log(`[Garmin MFA] submit status: ${res.status}, location: ${location.substring(0, 150)}`)

  // 检查 ticket
  const ticketMatch = TICKET_RE.exec(html)
  if (ticketMatch) return { ticket: ticketMatch[1] }

  if (location.includes('ticket=')) {
    const url = new URL(location, urls.ssoOrigin)
    return { ticket: url.searchParams.get('ticket') }
  }

  // 跟随重定向
  if ((res.status === 302 || res.status === 301) && location) {
    const redirectUrl = location.startsWith('http') ? location : `${urls.ssoOrigin}${location}`
    const redirectRes = await httpRequest(redirectUrl, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, ...(mfaState.cookieStr ? { 'Cookie': mfaState.cookieStr } : {}) },
      responseType: 'text',
      validateStatus: false,
      timeout: 15000,
    })
    const redirectHtml = redirectRes.data || ''
    const ticket = TICKET_RE.exec(redirectHtml)
    if (ticket) return { ticket: ticket[1] }
    // 重定向链的最终 URL 或 Location 头中也可能携带 ticket
    const finalUrl = redirectRes.url || ''
    const urlTicket = TICKET_RE.exec(finalUrl) || TICKET_RE.exec(redirectRes.headers['location'] || '')
    if (urlTicket) return { ticket: urlTicket[1] }
    console.error('[Garmin MFA] redirect has no ticket. html snippet:', redirectHtml.substring(0, 500))
  }

  if (MFA_RE.test(html)) {
    throw new Error('验证码错误或已过期')
  }
  throw new Error('MFA verification failed')
}

// ============ OAuth Token 交换 ============

/**
 * 获取 OAuth consumer key/secret
 */
async function getOauthConsumer() {
  const res = await httpRequest(OAUTH_CONSUMER_URL, { method: 'GET', responseType: 'json' })
  return { key: res.data.consumer_key, secret: res.data.consumer_secret }
}

/**
 * 用 ticket 换取 OAuth1 token
 */
async function getOauth1Token(ticket, urls) {
  const consumer = await getOauthConsumer()
  const oauth = createOAuthClient(consumer)

  const params = {
    ticket,
    'login-url': urls.ssoEmbed,
    'accepts-mfa-tokens': 'true',
  }
  const url = `${urls.oauthUrl}/preauthorized?${qsStringify(params)}`
  const requestData = { url, method: 'GET' }
  const headers = oauth.toHeader(oauth.authorize(requestData))

  const res = await httpRequest(url, {
    method: 'GET',
    headers: { ...headers, 'User-Agent': 'com.garmin.android.apps.connectmobile' },
    responseType: 'text',
  })

  const token = qsParse(res.data)
  return { token, oauth, consumer, urls }
}

/**
 * 用 OAuth1 换取 OAuth2 token
 */
async function exchangeOauth2(oauth1Data) {
  const { token, oauth, consumer } = oauth1Data
  const oauthToken = { key: token.oauth_token, secret: token.oauth_token_secret }

  const baseUrl = `${oauth1Data.urls.oauthUrl}/exchange/user/2.0`
  const requestData = { url: baseUrl, method: 'POST', data: null }
  const authData = oauth.authorize(requestData, oauthToken)
  const url = `${baseUrl}?${qsStringify(authData)}`

  const res = await httpRequest(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'com.garmin.android.apps.connectmobile',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    responseType: 'json',
  })

  const oauth2 = res.data
  oauth2.expires_at = Math.floor(Date.now() / 1000) + oauth2.expires_in
  return { oauth1: token, oauth2 }
}

/**
 * 获取用户信息
 */
async function getUserProfile(oauth1, oauth2, urls) {
  const consumer = await getOauthConsumer()
  const oauth = createOAuthClient(consumer)
  const oauthToken = { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret }

  const profileUrl = `${urls.apiBase}/userprofile-service/socialProfile`
  const requestData = { url: profileUrl, method: 'GET' }
  const headers = oauth.toHeader(oauth.authorize(requestData, oauthToken))

  const res = await httpRequest(profileUrl, {
    method: 'GET',
    headers: {
      ...headers,
      Authorization: `Bearer ${oauth2.access_token}`,
      'User-Agent': USER_AGENT,
    },
    responseType: 'json',
  })
  return res.data
}

// ============ 对外 API（给页面调用） ============

/**
 * 绑定 Garmin 账号（密码登录）
 * @returns { success, mfaRequired?, message, data? }
 */
export async function bindWithPassword(platform, username, password) {
  if (!platform || !username || !password) {
    return { success: false, message: '参数不完整' }
  }

  const region = platform === 'garminCn' ? 'cn' : 'com'

  try {
    const step1Result = await loginStep1(username, password, region)

    if (step1Result.mfaRequired) {
      // 保存 MFA 中间状态
      saveMfaState(platform, {
        username,
        password: encryptPassword(password),
        region,
        execution: step1Result.execution,
        csrfToken: step1Result.csrfToken || '',
        fromPage: step1Result.fromPage || '',
        cookieStr: step1Result.cookieStr,
        urls: step1Result.urls,
        mfaEndpoint: step1Result.mfaEndpoint,
      })
      return { success: true, mfaRequired: true, message: '需要输入短信验证码' }
    }

    // 直接获取 ticket，完成 OAuth
    const oauth1Data = await getOauth1Token(step1Result.ticket, step1Result.urls)
    const tokens = await exchangeOauth2(oauth1Data)
    const userInfo = await getUserProfile(tokens.oauth1, tokens.oauth2, step1Result.urls)

    const displayName = userInfo.fullName || userInfo.userName || username
    updatePlatformData(platform, {
      bound: true,
      oauth1: { oauth_token: tokens.oauth1.oauth_token, oauth_token_secret: tokens.oauth1.oauth_token_secret },
      oauth2: tokens.oauth2,
      displayName,
      username,
      password: encryptPassword(password),
    })

    return { success: true, message: '绑定成功', data: { displayName } }
  } catch (err) {
    console.error('bindWithPassword error:', err)
    return handleLoginError(err)
  }
}

/**
 * 提交 MFA 验证码
 */
export async function submitMfa(platform, mfaCode) {
  if (!mfaCode) return { success: false, message: '请输入验证码' }

  try {
    const state = getMfaState(platform)
    if (!state) {
      return { success: false, message: '登录会话已过期，请重新输入账号密码' }
    }

    const password = decryptPassword(state.password)
    const step2Result = await loginStep2Mfa({
      execution: state.execution,
      csrfToken: state.csrfToken,
      fromPage: state.fromPage,
      cookieStr: state.cookieStr,
      urls: state.urls,
      mfaEndpoint: state.mfaEndpoint,
    }, mfaCode)

    const oauth1Data = await getOauth1Token(step2Result.ticket, state.urls)
    const tokens = await exchangeOauth2(oauth1Data)
    const userInfo = await getUserProfile(tokens.oauth1, tokens.oauth2, state.urls)

    const displayName = userInfo.fullName || userInfo.userName || state.username
    updatePlatformData(platform, {
      bound: true,
      oauth1: { oauth_token: tokens.oauth1.oauth_token, oauth_token_secret: tokens.oauth1.oauth_token_secret },
      oauth2: tokens.oauth2,
      displayName,
      username: state.username,
      password: encryptPassword(password),
    })

    clearMfaState(platform)
    return { success: true, message: '绑定成功', data: { displayName } }
  } catch (err) {
    console.error('submitMfa error:', err)
    if (err.message?.includes('验证码') || err.message?.includes('MFA code')) {
      return { success: false, message: '验证码错误或已过期，请重新获取' }
    }
    return handleLoginError(err)
  }
}

/**
 * 解绑平台
 */
export function unbindPlatform(platform) {
  updatePlatformData(platform, {
    bound: false, oauth1: null, oauth2: null, displayName: '', username: '', password: '',
  })
  clearMfaState(platform)
  return { success: true, message: '解绑成功' }
}

/**
 * 自动重新登录（token 失效时用保存的密码）
 */
export async function autoRelogin(platform) {
  if (!platform.startsWith('garmin')) {
    return { success: false, message: '仅支持 Garmin 平台' }
  }

  const userData = getUserData()
  const platformData = userData[platform]
  if (!platformData?.bound || !platformData.username || !platformData.password) {
    return { success: false, message: '登录凭据缺失，请手动重新绑定' }
  }

  const username = platformData.username
  const password = decryptPassword(platformData.password)
  const region = platform === 'garminCn' ? 'cn' : 'com'

  try {
    const step1Result = await loginStep1(username, password, region)

    if (step1Result.mfaRequired) {
      saveMfaState(platform, {
        username, password: encryptPassword(password), region,
        execution: step1Result.execution,
        csrfToken: step1Result.csrfToken || '',
        fromPage: step1Result.fromPage || '',
        cookieStr: step1Result.cookieStr,
        urls: step1Result.urls, mfaEndpoint: step1Result.mfaEndpoint,
      })
      return { success: false, mfaRequired: true, message: '需要输入验证码' }
    }

    const oauth1Data = await getOauth1Token(step1Result.ticket, step1Result.urls)
    const tokens = await exchangeOauth2(oauth1Data)
    const userInfo = await getUserProfile(tokens.oauth1, tokens.oauth2, step1Result.urls)

    const displayName = userInfo.fullName || userInfo.userName || username
    updatePlatformData(platform, {
      bound: true,
      oauth1: { oauth_token: tokens.oauth1.oauth_token, oauth_token_secret: tokens.oauth1.oauth_token_secret },
      oauth2: tokens.oauth2,
      displayName, username,
      password: encryptPassword(password),
    })

    return { success: true, message: '自动重新登录成功', data: { displayName } }
  } catch (err) {
    console.error('autoRelogin error:', err)
    return { success: false, message: `自动重新登录失败: ${err.message}` }
  }
}

// ============ 辅助 ============

function handleLoginError(err) {
  const msg = err.message || '未知错误'
  if (msg.includes('MFA') || msg.includes('mfa')) return { success: false, message: '验证码验证失败，请重新获取' }
  if (msg.includes('No ticket') || msg.includes('wrong password') || msg.includes('401')) return { success: false, message: '账号或密码错误，请检查后重试' }
  if (msg.includes('AccountLocked')) return { success: false, message: '账号已锁定，请在网页端解锁' }
  if (msg.includes('CSRF')) return { success: false, message: '登录页面加载失败，请稍后重试' }
  if (msg.includes('Update Phone')) return { success: false, message: '需要更新手机号码，请在网页端更新后重试' }
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('timeout')) return { success: false, message: '网络连接失败，无法访问 Garmin 服务器' }
  return { success: false, message: `绑定失败: ${msg}` }
}
