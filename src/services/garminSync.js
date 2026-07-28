/**
 * Garmin 同步服务 - 从 garminSync 云函数迁移
 * 活动列表获取、FIT 文件下载/上传、token 刷新
 */
import { httpRequest, qsStringify } from './http.js'
import { createOAuthClient } from '../utils/oauth1.js'
import { getUserData, updatePlatformData } from './storage.js'
import { autoRelogin } from './garminAuth.js'
import JSZip from 'jszip'

const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json'
const USER_AGENT = 'com.garmin.android.apps.connectmobile'

// ============ API 客户端 ============

/**
 * 获取 Garmin API 信息（含 token 自动刷新）
 */
export async function getPlatformApi(platform) {
  const userData = getUserData()
  const platformData = userData[platform]

  if (!platformData?.bound) {
    const name = platform === 'garminCn' ? '佳明国服' : '佳明国际服'
    throw new Error(`${name} 未绑定`)
  }

  if (!platformData.oauth1 || !platformData.oauth2) {
    throw new Error('登录凭证缺失，请重新绑定')
  }

  const domain = platform === 'garminCn' ? 'garmin.cn' : 'garmin.com'
  const apiBase = `https://connectapi.${domain}`

  let oauth2 = { ...platformData.oauth2 }
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = oauth2.expires_at ? oauth2.expires_at - now : 0

  if (!oauth2.expires_at || now >= oauth2.expires_at - 300) {
    console.log(`${platform}: token needs refresh (expires_in=${expiresIn}s)`)
    try {
      oauth2 = await refreshOauth2Token(platformData.oauth1, apiBase)
      updatePlatformData(platform, { oauth2 })
      console.log(`${platform}: token refreshed`)
    } catch (refreshErr) {
      console.error(`${platform}: token refresh failed:`, refreshErr.message)
      // 尝试自动重新登录
      if (platform.startsWith('garmin') && platformData.password) {
        const reloginRes = await autoRelogin(platform)
        if (reloginRes.success) {
          const freshData = getUserData()[platform]
          oauth2 = freshData.oauth2
        } else if (reloginRes.mfaRequired) {
          return { mfaRequired: true, platform, message: reloginRes.message }
        } else {
          throw new Error(`${platform === 'garminCn' ? '佳明国服' : '佳明国际服'}登录凭证已失效，请重新绑定`)
        }
      } else {
        throw new Error(`${platform === 'garminCn' ? '佳明国服' : '佳明国际服'}登录凭证已失效，请重新绑定`)
      }
    }
  }

  return {
    apiBase,
    oauth1: platformData.oauth1,
    oauth2,
    displayName: platformData.displayName || '',
  }
}

/**
 * 刷新 OAuth2 token
 */
async function refreshOauth2Token(oauth1, apiBase) {
  const consumerRes = await httpRequest(OAUTH_CONSUMER_URL, { method: 'GET', responseType: 'json' })
  const consumer = { key: consumerRes.data.consumer_key, secret: consumerRes.data.consumer_secret }
  const oauth = createOAuthClient(consumer)

  const exchangeUrl = `${apiBase}/oauth-service/oauth/exchange/user/2.0`
  const oauthToken = { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret }
  const requestData = { url: exchangeUrl, method: 'POST', data: null }
  const authData = oauth.authorize(requestData, oauthToken)
  const url = `${exchangeUrl}?${qsStringify(authData)}`

  const res = await httpRequest(url, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    responseType: 'json',
  })

  const oauth2 = res.data
  oauth2.expires_at = Math.floor(Date.now() / 1000) + oauth2.expires_in
  return oauth2
}

/**
 * 带 OAuth2 Bearer 认证的请求
 */
async function apiRequest(apiBase, oauth2, path, options = {}) {
  const url = `${apiBase}${path}`
  return httpRequest(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${oauth2.access_token}`,
      'User-Agent': USER_AGENT,
      ...(options.headers || {}),
    },
  })
}

/**
 * 验证 token 是否有效
 */
export async function validateToken(apiBase, oauth2) {
  const res = await apiRequest(apiBase, oauth2, '/userprofile-service/socialProfile', { responseType: 'json' })
  return res.data
}

// ============ Garmin 活动 API ============

/**
 * 获取活动列表
 */
export async function fetchActivities(apiBase, oauth2, start = 0, limit = 20) {
  const res = await apiRequest(apiBase, oauth2,
    `/activitylist-service/activities/search/activities?start=${start}&limit=${limit}`,
    { responseType: 'json' }
  )
  return res.data
}

/**
 * 下载 Garmin 活动的 FIT 文件（从 zip 中解压）
 */
export async function downloadGarminActivity(apiBase, oauth2, activityId) {
  const res = await apiRequest(apiBase, oauth2,
    `/download-service/files/activity/${activityId}`,
    { responseType: 'arraybuffer', timeout: 60000 }
  )

  const arrayBuffer = res.data
  const byteLength = arrayBuffer instanceof ArrayBuffer ? arrayBuffer.byteLength : 0
  console.log(`downloadGarminActivity: response type=${typeof arrayBuffer}, isAB=${arrayBuffer instanceof ArrayBuffer}, size=${byteLength}`)
  console.log(`downloadGarminActivity: status=${res.status}, content-type=${res.headers?.['content-type'] || '(unknown)'}`)

  // 诊断：打印前 8 字节，确认是否为 PK 头
  if (byteLength > 0) {
    const headBytes = new Uint8Array(arrayBuffer, 0, Math.min(8, byteLength))
    console.log(`downloadGarminActivity: head bytes = [${Array.from(headBytes).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}]`)
  }

  // 校验数据有效性
  if (byteLength < 22) {
    throw new Error(`下载数据无效: 仅 ${byteLength} 字节，不是有效的 zip 文件`)
  }
  const view = new Uint8Array(arrayBuffer)
  // zip 必须以 PK (0x50, 0x4b) 开头
  if (view[0] !== 0x50 || view[1] !== 0x4b) {
    throw new Error('下载数据不是 zip 格式')
  }

  let zip
  try {
    zip = await JSZip.loadAsync(arrayBuffer)
  } catch (zipErr) {
    console.error('JSZip loadAsync failed:', zipErr.message)
    throw new Error(`zip 解析失败: ${zipErr.message}`)
  }

  const files = Object.keys(zip.files)
  if (files.length === 0) throw new Error('解压失败：zip 文件为空（无有效记录）')

  const fitFileName = files.find(f => f.endsWith('.fit')) || files[0]
  const fitData = await zip.files[fitFileName].async('uint8array')

  console.log(`downloadGarminActivity: extracted ${fitFileName}, size = ${fitData.length} bytes`)
  return { path: fitFileName, data: fitData }
}

/**
 * 上传 FIT 文件到 Garmin
 */
export async function uploadGarminActivity(apiBase, oauth2, fitData, filename) {
  // 构建 multipart/form-data
  const blob = new Blob([fitData], { type: 'application/octet-stream' })
  const formData = new FormData()
  formData.append('userfile', blob, filename || 'activity.fit')

  console.log(`[garmin] upload: fitData=${fitData.length} bytes, filename=${filename || 'activity.fit'}`)

  try {
    const res = await apiRequest(apiBase, oauth2, '/upload-service/upload/fit', {
      method: 'POST',
      body: formData,
      responseType: 'json',
      timeout: 60000,
    })

    console.log('upload to garmin:', JSON.stringify(res.data).substring(0, 200))
    // 参考 garmin-sync-coros：佳明的重复活动有两种返回形态，
    // 除 HTTP 409 外，还会返回 HTTP 202 但 detailedImportResult.uploadId 为空（静默去重）
    const importResult = res.data?.detailedImportResult
    const uploadId = importResult?.uploadId
    if (importResult && (uploadId === null || uploadId === undefined || uploadId === '')) {
      console.log('[garmin] upload judged duplicate: empty uploadId')
      return { duplicate: true, data: res.data }
    }
    return { duplicate: false, data: res.data }
  } catch (err) {
    // 409 = 佳明明确返回重复活动
    if (err.status === 409) {
      console.log('[garmin] upload duplicate: HTTP 409')
      return { duplicate: true, data: err.response?.data }
    }
    console.error('[garmin] upload failed:', err.message)
    if (err.response) {
      console.error('[garmin] upload response status:', err.status)
      console.error('[garmin] upload response data:', JSON.stringify(err.response.data).substring(0, 500))
    }
    throw err
  }
}

// ============ 带重试的请求封装 ============

/**
 * 判断是否需要刷新 token
 */
export function shouldRefreshToken(err) {
  const status = err?.status || err?.response?.status
  return status === 401 || status === 403 || status === 500 || status === 502 || status === 503 || status === 504
}

/**
 * 刷新 token 并更新存储
 */
export async function refreshTokenForPlatform(platform) {
  const userData = getUserData()
  const platformData = userData[platform]
  const domain = platform === 'garminCn' ? 'garmin.cn' : 'garmin.com'
  const apiBase = `https://connectapi.${domain}`

  try {
    const newOauth2 = await refreshOauth2Token(platformData.oauth1, apiBase)
    updatePlatformData(platform, { oauth2: newOauth2 })
    return newOauth2
  } catch (err) {
    // 尝试自动重新登录
    const reloginRes = await autoRelogin(platform)
    if (reloginRes.success) {
      return getUserData()[platform].oauth2
    } else if (reloginRes.mfaRequired) {
      return { mfaRequired: true, platform, message: reloginRes.message }
    }
    throw err
  }
}
