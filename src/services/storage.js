/**
 * 本地存储封装 - 替代微信云数据库
 * 使用 localStorage 实现简单的 KV 存储
 *
 * 数据结构：
 * - "userData": { garminCn: {...}, garminCom: {...}, coros: {...}, lastSyncTime: "" }
 * - "syncRecords": [ { _id, direction, activityId, activityName, status, ... } ]
 * - "mfaState_{platform}": { username, password, region, execution, cookieStr, urls, mfaEndpoint, createdAt }
 */

const KEYS = {
  USER_DATA: 'jjt_userData',
  SYNC_RECORDS: 'jjt_syncRecords',
}

// ============ 用户数据 ============

/**
 * 获取用户绑定数据
 */
export function getUserData() {
  const raw = localStorage.getItem(KEYS.USER_DATA)
  if (!raw) {
    return getDefaultUserData()
  }
  try {
    return JSON.parse(raw)
  } catch {
    return getDefaultUserData()
  }
}

function getDefaultUserData() {
  return {
    garminCn: { bound: false, oauth1: null, oauth2: null, displayName: '', username: '' },
    garminCom: { bound: false, oauth1: null, oauth2: null, displayName: '', username: '' },
    coros: { bound: false, accessToken: null, userId: '', regionId: 2, displayName: '', email: '' },
    lastSyncTime: '',
  }
}

/**
 * 保存用户数据
 */
export function saveUserData(data) {
  localStorage.setItem(KEYS.USER_DATA, JSON.stringify(data))
}

/**
 * 更新指定平台数据
 */
export function updatePlatformData(platform, platformData) {
  const userData = getUserData()
  userData[platform] = { ...userData[platform], ...platformData }
  userData.updatedAt = new Date().toISOString()
  saveUserData(userData)
  return userData
}

/**
 * 获取绑定信息摘要（给前端展示用）
 */
export function getBindInfo() {
  const userData = getUserData()
  return {
    success: true,
    data: {
      garminCn: {
        bound: !!userData.garminCn?.bound,
        displayName: userData.garminCn?.displayName || '',
      },
      garminCom: {
        bound: !!userData.garminCom?.bound,
        displayName: userData.garminCom?.displayName || '',
      },
      coros: {
        bound: !!userData.coros?.bound,
        displayName: userData.coros?.displayName || '',
      },
      lastSyncTime: userData.lastSyncTime || '',
    },
  }
}

// ============ MFA 中间状态 ============

/**
 * 保存 MFA 中间状态
 */
export function saveMfaState(platform, state) {
  const mfaState = {
    username: state.username,
    password: state.password || '',
    region: state.region,
    execution: state.execution || '',
    cookieStr: state.cookieStr || '',
    urls: state.urls || {},
    mfaEndpoint: state.mfaEndpoint || '',
    createdAt: Date.now(),
  }
  localStorage.setItem(`jjt_mfaState_${platform}`, JSON.stringify(mfaState))
}

/**
 * 获取 MFA 状态（5 分钟过期）
 */
export function getMfaState(platform) {
  const raw = localStorage.getItem(`jjt_mfaState_${platform}`)
  if (!raw) return null
  try {
    const state = JSON.parse(raw)
    if (Date.now() - state.createdAt > 5 * 60 * 1000) return null
    return state
  } catch {
    return null
  }
}

/**
 * 清除 MFA 状态
 */
export function clearMfaState(platform) {
  localStorage.removeItem(`jjt_mfaState_${platform}`)
}

// ============ 同步记录 ============

/**
 * 获取同步记录（分页）
 */
export function getSyncRecords(page = 0, pageSize = 20) {
  const records = getAllSyncRecords()
  // 按创建时间倒序
  records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const start = page * pageSize
  const slice = records.slice(start, start + pageSize)
  return {
    success: true,
    data: slice,
    total: records.length,
    hasMore: start + pageSize < records.length,
  }
}

/**
 * 获取所有同步记录
 */
export function getAllSyncRecords() {
  const raw = localStorage.getItem(KEYS.SYNC_RECORDS)
  if (!raw) return []
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

/**
 * 保存所有同步记录
 */
function saveAllSyncRecords(records) {
  localStorage.setItem(KEYS.SYNC_RECORDS, JSON.stringify(records))
}

/**
 * 创建同步记录
 */
export function createSyncRecord(record) {
  const records = getAllSyncRecords()
  const newRecord = {
    _id: `record_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    ...record,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  records.push(newRecord)
  saveAllSyncRecords(records)
  return newRecord
}

/**
 * 更新同步记录
 */
export function updateSyncRecord(recordId, updates) {
  const records = getAllSyncRecords()
  const idx = records.findIndex(r => r._id === recordId)
  if (idx >= 0) {
    records[idx] = { ...records[idx], ...updates, updatedAt: new Date().toISOString() }
    saveAllSyncRecords(records)
    return records[idx]
  }
  return null
}

/**
 * 按条件查找同步记录
 */
export function findSyncRecord(query) {
  const records = getAllSyncRecords()
  return records.find(r => {
    return Object.entries(query).every(([k, v]) => r[k] === v)
  })
}

// ============ 辅助 ============

/**
 * 更新最后同步时间
 */
export function updateLastSyncTime(direction, lastSyncedActTime) {
  const userData = getUserData()
  userData.lastSyncTime = new Date().toLocaleString('zh-CN')
  if (direction && lastSyncedActTime) {
    userData[`lastSyncedActTime_${direction}`] = lastSyncedActTime
  }
  saveUserData(userData)
}

/**
 * 获取方向的最后同步活动时间
 */
export function getLastSyncedActTime(direction) {
  const userData = getUserData()
  return userData[`lastSyncedActTime_${direction}`] || null
}

/**
 * 清除方向的最后同步时间（强制重新同步）
 */
export function clearLastSyncedActTime(direction) {
  const userData = getUserData()
  delete userData[`lastSyncedActTime_${direction}`]
  saveUserData(userData)
}
