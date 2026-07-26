/**
 * COROS 认证服务 - 从 garminAuth 云函数中的 COROS 部分迁移
 * 支持 COROS 登录、session 刷新
 */
import { httpRequest } from './http.js'
import { md5, encryptPassword, decryptPassword } from '../utils/crypto.js'
import { getUserData, updatePlatformData } from './storage.js'

// COROS 登录端点（统一使用 CN 入口）
const COROS_LOGIN_API = 'https://teamcnapi.coros.com'

// COROS 区域 → teamapi 映射
export const COROS_REGION_API = {
  1: 'https://teamapi.coros.com',    // 美区
  2: 'https://teamcnapi.coros.com',  // 中国区
  3: 'https://teameuapi.coros.com',  // 欧区
}

/**
 * COROS 登录：用邮箱+密码换取 access token
 * @returns { accessToken, userId, regionId, teamApi, displayName, expiresAt }
 */
export async function corosLogin(email, password) {
  const hashedPwd = md5(password)

  const loginRes = await httpRequest(`${COROS_LOGIN_API}/account/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept': 'application/json, text/plain, */*',
    },
    body: JSON.stringify({
      account: email,
      accountType: 2,
      pwd: hashedPwd,
    }),
    responseType: 'json',
    validateStatus: false,
    timeout: 15000,
  })

  if (loginRes.status !== 200) {
    if (loginRes.status === 401 || loginRes.status === 403) {
      throw new Error('COROS 账号或密码错误')
    }
    throw new Error(`COROS 登录失败: HTTP ${loginRes.status}`)
  }

  const data = loginRes.data || {}
  const isSuccess = data.result === '0000' || data.apiCode === '41C2B95C' || data.code === 200

  if (!isSuccess) {
    throw new Error(`COROS 登录失败: ${data.message || data.msg || '未知错误'}`)
  }

  const loginData = data.data || {}
  const accessToken = loginData.accessToken || data.accessToken || ''
  const userId = loginData.userId || data.userId || ''
  const regionId = loginData.regionId || data.regionId || 2

  if (!accessToken) {
    throw new Error('COROS 登录成功但未找到 access token')
  }

  const displayName = loginData.nickName || loginData.name || loginData.userName || email
  const teamApi = COROS_REGION_API[regionId] || COROS_REGION_API[2]
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000

  return { accessToken, userId, regionId, teamApi, displayName, expiresAt }
}

/**
 * 绑定 COROS 账号
 */
export async function corosBind(email, password) {
  if (!email || !password) {
    return { success: false, message: '请输入邮箱和密码' }
  }

  try {
    const result = await corosLogin(email.trim(), password)

    updatePlatformData('coros', {
      bound: true,
      accessToken: result.accessToken,
      userId: result.userId,
      regionId: result.regionId,
      teamApi: result.teamApi,
      displayName: result.displayName,
      email: email.trim(),
      password: encryptPassword(password),
      expiresAt: result.expiresAt,
    })

    return {
      success: true,
      message: 'COROS 绑定成功',
      data: { displayName: result.displayName },
    }
  } catch (err) {
    console.error('corosBind error:', err)
    if (err.message.includes('密码') || err.message.includes('账号')) {
      return { success: false, message: err.message }
    }
    return { success: false, message: `COROS 绑定失败: ${err.message}` }
  }
}

/**
 * 刷新 COROS session（过期时自动调用）
 */
export async function corosRefresh() {
  const userData = getUserData()
  const corosData = userData.coros

  if (!corosData?.bound || !corosData.email || !corosData.password) {
    throw new Error('COROS 未绑定或凭证缺失，请重新绑定')
  }

  const plainPassword = decryptPassword(corosData.password)
  const result = await corosLogin(corosData.email, plainPassword)

  updatePlatformData('coros', {
    accessToken: result.accessToken,
    userId: result.userId || corosData.userId,
    regionId: result.regionId || corosData.regionId,
    teamApi: result.teamApi,
    displayName: result.displayName,
    expiresAt: result.expiresAt,
  })

  return result
}

/**
 * 获取有效的 COROS session（过期自动刷新）
 * @param {boolean} forceRefresh - 强制刷新 token（忽略过期检查）
 */
export async function getCorosSession(forceRefresh = false) {
  const userData = getUserData()
  const corosData = userData.coros

  if (!corosData?.bound) {
    throw new Error('COROS 未绑定')
  }

  const sessionExpired = corosData.expiresAt && Date.now() >= corosData.expiresAt
  const userIdMissing = !corosData.userId
  const regionIdMissing = !corosData.regionId

  if (forceRefresh || sessionExpired || userIdMissing || regionIdMissing) {
    console.log(`COROS session refresh triggered: forceRefresh=${forceRefresh}, expired=${sessionExpired}, userIdMissing=${userIdMissing}, regionMissing=${regionIdMissing}`)
    await corosRefresh()
    // 重新读取最新数据
    const freshData = getUserData().coros
    return {
      accessToken: freshData.accessToken,
      userId: freshData.userId,
      regionId: freshData.regionId,
      teamApi: freshData.teamApi || COROS_REGION_API[freshData.regionId || 2],
    }
  }

  return {
    accessToken: corosData.accessToken,
    userId: corosData.userId,
    regionId: corosData.regionId || 2,
    teamApi: corosData.teamApi || COROS_REGION_API[corosData.regionId || 2],
  }
}

/**
 * 判断错误是否为 COROS token 失效
 */
export function isCorosTokenError(err) {
  const msg = (err.message || '').toLowerCase()
  return msg.includes('token') && (msg.includes('invalid') || msg.includes('expired'))
}

/**
 * 解绑 COROS
 */
export function corosUnbind() {
  updatePlatformData('coros', {
    bound: false, accessToken: null, userId: '', regionId: 2,
    teamApi: '', displayName: '', email: '', password: '', expiresAt: 0,
  })
  return { success: true, message: '解绑成功' }
}
