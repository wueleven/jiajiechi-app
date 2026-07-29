/**
 * 启动自动同步服务
 * 1. App 冷启动时按上一次同步方案（方向 + 数量）静默执行一次同步
 * 2. 进程未死但后台停留超过阈值后切回前台，再次自动同步
 *
 * 安全规则：
 * - forceResync 永远为 false（即使上次手动同步勾选了强制重同步）
 * - syncCount 为 'all' 时降级为最近 50 条，避免启动时意外全量拉取
 * - 与手动同步共用 globalSyncing 锁，互斥执行
 */
import { ref } from 'vue'
import { App } from '@capacitor/app'
import { getLastSyncPrefs, getBindInfo } from './storage.js'
import { syncActivities } from './syncOrchestrator.js'

// 全局同步锁：自动同步与手动同步互斥
export const globalSyncing = ref(false)
// 当前是否为自动同步（供 App.vue 顶部状态条展示）
export const autoSyncRunning = ref(false)
// 最近一次自动同步完成时间戳（页面监听此值刷新展示数据）
export const autoSyncCompletedAt = ref(0)

const AUTO_SYNC_MAX_COUNT = 50
// 后台停留超过此时长，回前台时再次触发自动同步
const RESUME_BACKGROUND_MS = 60 * 60 * 1000

// 冷启动仅执行一次
let launched = false
// 切入后台的时间戳（内存变量，进程被杀后自然走冷启动路径）
let backgroundAt = 0
let resumeListenerRegistered = false

// 同步配对 → 平台 key（与 sync.vue 的 SYNC_PAIRS 保持一致）
const PAIR_PLATFORMS = {
  'garminCn-garminCom': ['garminCn', 'garminCom'],
  'garminCn-coros': ['garminCn', 'coros'],
  'garminCom-coros': ['garminCom', 'coros'],
}

/**
 * 由配对 id 和箭头方向构造同步方向字符串（与 sync.vue getCurrentDirection 同规则）
 */
function buildDirection(pairId, reversed) {
  const platforms = PAIR_PLATFORMS[pairId]
  if (!platforms) return ''
  const from = reversed ? platforms[1] : platforms[0]
  const to = reversed ? platforms[0] : platforms[1]
  return from + 'To' + to.charAt(0).toUpperCase() + to.slice(1)
}

/**
 * 自动同步核心流程（冷启动与前台恢复共用）
 * @returns {Promise<Object|null>} 未触发（开关关闭/条件不满足）时返回 null，
 *   否则返回 syncActivities 的结果对象供调用方提示
 */
async function runAutoSync() {
  const prefs = getLastSyncPrefs()
  if (!prefs?.autoSyncOnLaunch) return null

  const bind = getBindInfo()
  if (!bind.success) return null
  const isBound = p => !!bind.data[p]?.bound

  // 优先用已保存的方案；方案缺失或其平台已解绑时，回退到当前第一个可用配对
  // （与同步页默认选中规则一致），避免开关已打开却静默不生效
  let pairId = prefs.pairId
  let reversed = !!prefs.reversed
  if (!PAIR_PLATFORMS[pairId] || !PAIR_PLATFORMS[pairId].every(isBound)) {
    pairId = Object.keys(PAIR_PLATFORMS).find(id => PAIR_PLATFORMS[id].every(isBound)) || ''
    reversed = false
  }
  if (!pairId) return null

  const direction = buildDirection(pairId, reversed)
  if (!direction) return null

  if (globalSyncing.value) return null

  let syncCount = prefs.syncCount || 5
  if (syncCount === 'all') syncCount = AUTO_SYNC_MAX_COUNT

  globalSyncing.value = true
  autoSyncRunning.value = true
  try {
    console.log(`[autoSync] run: direction=${direction}, count=${syncCount}`)
    return await syncActivities(direction, false, syncCount)
  } catch (err) {
    console.error('[autoSync] failed:', err)
    return { success: false, message: err.message }
  } finally {
    globalSyncing.value = false
    autoSyncRunning.value = false
    // 通知首页/历史页：自动同步已结束，刷新展示数据
    autoSyncCompletedAt.value = Date.now()
  }
}

/**
 * 启动时自动同步（每次冷启动仅执行一次）
 */
export async function runAutoSyncOnLaunch() {
  if (launched) return null
  launched = true
  return runAutoSync()
}

/**
 * 注册前后台监听：后台停留超过 RESUME_BACKGROUND_MS 后切回前台，再次自动同步
 * （@capacitor/app 在 Web 端基于 visibilitychange 实现，开发环境同样可验证）
 * @param {Function} onResult - 同步触发后的结果回调（与冷启动共用提示逻辑）
 */
export function setupResumeAutoSync(onResult) {
  if (resumeListenerRegistered) return
  resumeListenerRegistered = true

  App.addListener('appStateChange', async ({ isActive }) => {
    if (!isActive) {
      backgroundAt = Date.now()
      return
    }
    // 回前台：按后台停留时长判断（而非距上次同步时长，避免快速切 App 误触发）
    if (!backgroundAt || Date.now() - backgroundAt < RESUME_BACKGROUND_MS) return
    backgroundAt = 0
    console.log('[autoSync] resumed after long background, triggering sync')
    const res = await runAutoSync()
    if (res && typeof onResult === 'function') onResult(res)
  })
}
