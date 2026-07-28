/**
 * 同步编排服务 - 整合 garminSync 和 corosSync
 * 实现各方向的完整同步流程
 */
import { getPlatformApi, fetchActivities, downloadGarminActivity, uploadGarminActivity, shouldRefreshToken, refreshTokenForPlatform } from './garminSync.js'
import { getCorosSession, isCorosTokenError } from './corosAuth.js'
import { uploadToCoros, fetchCorosActivities, downloadCorosFit } from './corosSync.js'
import { createSyncRecord, updateSyncRecord, findSyncRecord } from './syncRecord.js'
import { updateLastSyncTime } from './storage.js'

const DEFAULT_SYNC_NUM = 5
const PAGE_SIZE = 20

/**
 * 执行同步
 * @param {string} direction - 同步方向
 * @param {boolean} forceResync - 是否强制重新同步
 * @param {number|string} syncCount - 同步数量，数字或 'all'
 * @returns { success, data: { total, success, failed, skipped }, mfaRequired? }
 */
export async function syncActivities(direction, forceResync = false, syncCount = DEFAULT_SYNC_NUM) {
  if (!direction) return { success: false, message: '请指定同步方向' }

  // 解析同步数量
  const fetchAll = syncCount === 'all'
  const limit = fetchAll ? PAGE_SIZE : Math.max(1, parseInt(syncCount, 10) || DEFAULT_SYNC_NUM)

  // 解析方向
  let sourcePlatform = '', targetPlatform = ''
  let targetIsCoros = false, sourceIsCoros = false

  switch (direction) {
    case 'garminCnToGarminCom': sourcePlatform = 'garminCn'; targetPlatform = 'garminCom'; break
    case 'garminComToGarminCn': sourcePlatform = 'garminCom'; targetPlatform = 'garminCn'; break
    case 'garminCnToCoros':     sourcePlatform = 'garminCn'; targetIsCoros = true; break
    case 'garminComToCoros':    sourcePlatform = 'garminCom'; targetIsCoros = true; break
    case 'corosToGarminCn':     sourceIsCoros = true; targetPlatform = 'garminCn'; break
    case 'corosToGarminCom':    sourceIsCoros = true; targetPlatform = 'garminCom'; break
    default: return { success: false, message: '暂不支持该同步方向' }
  }

  const result = { total: 0, success: 0, failed: 0, skipped: 0, errors: [] }

  try {
    // 1. 获取源平台客户端
    let sourceApiBase, sourceOauth2
    let sourceCorosSession = null

    if (sourceIsCoros) {
      sourceCorosSession = await getCorosSession()
    } else {
      const sourceApi = await getPlatformApi(sourcePlatform)
      if (sourceApi.mfaRequired) {
        return { success: false, mfaRequired: true, platform: sourceApi.platform, message: sourceApi.message }
      }
      sourceApiBase = sourceApi.apiBase
      sourceOauth2 = sourceApi.oauth2
    }

    // 2. 获取目标平台信息
    let targetApiBase, targetOauth2
    let corosSession = null

    if (targetIsCoros) {
      corosSession = await getCorosSession()
    } else {
      const targetApi = await getPlatformApi(targetPlatform)
      if (targetApi.mfaRequired) {
        return { success: false, mfaRequired: true, platform: targetApi.platform, message: targetApi.message }
      }
      targetApiBase = targetApi.apiBase
      targetOauth2 = targetApi.oauth2
    }

    // 目标为高驰时预取其现有活动的开始时间（秒级时间戳）：
    // 高驰导入接口异步处理，响应不返回重复信息，只能上传前主动对照判重
    let corosExistingTimes = []
    if (targetIsCoros) {
      try {
        let existing
        try {
          existing = await fetchCorosActivities(corosSession, 1, 200)
        } catch (preErr) {
          if (isCorosTokenError(preErr)) {
            corosSession = await getCorosSession(true)
            existing = await fetchCorosActivities(corosSession, 1, 200)
          } else throw preErr
        }
        corosExistingTimes = (existing || [])
          .map(a => a.corosRaw?.startTime)
          .filter(t => typeof t === 'number')
          .map(t => (t < 1e12 ? t : Math.floor(t / 1000)))
        console.log(`[sync] 高驰已有活动预检: ${corosExistingTimes.length} 条`)
      } catch (preErr) {
        // 预检失败不阻塞同步，仅失去事前判重能力
        console.warn('[sync] 高驰已有活动预检失败:', preErr.message)
      }
    }

    // 3. 拉取源平台活动
    let sourceActs = []
    if (sourceIsCoros) {
      try {
        if (fetchAll) {
          let page = 1
          while (true) {
            const batch = await fetchCorosActivities(sourceCorosSession, page, PAGE_SIZE)
            if (!batch || batch.length === 0) break
            sourceActs.push(...batch)
            if (batch.length < PAGE_SIZE) break
            page++
          }
        } else {
          sourceActs = await fetchCorosActivities(sourceCorosSession, 1, limit)
        }
      } catch (actErr) {
        // COROS token 失效时强制刷新并重试
        if (isCorosTokenError(actErr)) {
          console.log('[sync] COROS token invalid, force refreshing session...')
          sourceCorosSession = await getCorosSession(true)
          if (fetchAll) {
            let page = 1
            while (true) {
              const batch = await fetchCorosActivities(sourceCorosSession, page, PAGE_SIZE)
              if (!batch || batch.length === 0) break
              sourceActs.push(...batch)
              if (batch.length < PAGE_SIZE) break
              page++
            }
          } else {
            sourceActs = await fetchCorosActivities(sourceCorosSession, 1, limit)
          }
        } else throw actErr
      }
    } else {
      if (fetchAll) {
        let offset = 0
        while (true) {
          const batch = await fetchActivities(sourceApiBase, sourceOauth2, offset, PAGE_SIZE)
          if (!batch || batch.length === 0) break
          sourceActs.push(...batch)
          if (batch.length < PAGE_SIZE) break
          offset += PAGE_SIZE
        }
      } else {
        sourceActs = await fetchActivities(sourceApiBase, sourceOauth2, 0, limit)
      }
    }

    result.total = sourceActs.length

    // 4. 倒序同步（从最早的新活动开始）
    const reversedActs = [...sourceActs].reverse()
    let actualNewCount = 1

    for (const act of reversedActs) {
      const activityName = act.activityName || '未知活动'
      const activityId = String(act.activityId)

      // 统一去重策略（参考 garmin-sync-coros）：不做跨平台时间对比，
      // 本地已有"成功"或"目标平台已存在(skipped)"记录即视为已同步；
      // 目标平台自身的重复识别（佳明 409 / 高驰已存在）作为兜底
      const synced = findSyncRecord({ activityId, direction, status: 'success' })
        || findSyncRecord({ activityId, direction, status: 'skipped' })
      if (!forceResync && synced) { result.skipped++; continue }

      // 高驰端已存在判重：用佳明 startTimeGMT（UTC）与高驰秒级时间戳对比，
      // 绝对时间对绝对时间，不受时区影响；同一活动的 FIT 开始时间一致，留 60s 容差
      if (targetIsCoros && corosExistingTimes.length > 0 && act.startTimeGMT) {
        const gmtSec = Math.floor(Date.parse(act.startTimeGMT.replace(' ', 'T') + 'Z') / 1000)
        if (gmtSec && corosExistingTimes.some(t => Math.abs(t - gmtSec) <= 60)) {
          createSyncRecord({
            direction, activityId, activityName,
            activityTime: act.startTimeLocal || '',
            status: 'skipped', errorMsg: '高驰已存在该活动',
          })
          result.skipped++
          continue
        }
      }

      try {
        // 创建同步记录
        const record = createSyncRecord({
          direction, activityId, activityName,
          activityTime: act.startTimeLocal || '',
          status: 'syncing',
        })

        // 下载 FIT 文件
        console.log(`Downloading: ${activityId} - ${activityName}`)
        let fitFile
        if (sourceIsCoros) {
          try {
            fitFile = await downloadCorosFit(sourceCorosSession, activityId, act.sportType)
          } catch (dlErr) {
            if (isCorosTokenError(dlErr)) {
              sourceCorosSession = await getCorosSession(true)
              fitFile = await downloadCorosFit(sourceCorosSession, activityId, act.sportType)
            } else throw dlErr
          }
        } else {
          try {
            fitFile = await downloadGarminActivity(sourceApiBase, sourceOauth2, act.activityId)
          } catch (dlErr) {
            if (shouldRefreshToken(dlErr)) {
              const newOauth2 = await refreshTokenForPlatform(sourcePlatform)
              if (newOauth2.mfaRequired) return { success: false, mfaRequired: true, ...newOauth2 }
              sourceOauth2 = newOauth2
              fitFile = await downloadGarminActivity(sourceApiBase, sourceOauth2, act.activityId)
            } else throw dlErr
          }
        }

        // 上传到目标平台
        console.log(`Uploading #${actualNewCount}: ${activityName}`)
        if (targetIsCoros) {
          let corosResult
          try {
            corosResult = await uploadToCoros(fitFile.data, fitFile.path, corosSession)
          } catch (ulErr) {
            // token 失效（如 1019）则刷新 session 重试一次；仍失败则冒泡到外层标 failed
            if (isCorosTokenError(ulErr)) {
              corosSession = await getCorosSession(true)
              corosResult = await uploadToCoros(fitFile.data, fitFile.path, corosSession)
            } else {
              throw ulErr
            }
          }
          if (corosResult?.duplicate) {
            updateSyncRecord(record._id, { status: 'skipped', errorMsg: 'COROS 已存在该活动' })
            result.skipped++
            continue
          }
          if (!corosResult?.success) {
            // 显式判失败：uploadToCoros 返回 success:false 但未 throw 的情况
            throw new Error(`COROS 导入未成功: ${JSON.stringify(corosResult)}`)
          }
          // 成功计数统一在循环尾部处理，避免重复累加
        } else {
          let garminResult
          try {
            garminResult = await uploadGarminActivity(targetApiBase, targetOauth2, fitFile.data, fitFile.path)
          } catch (ulErr) {
            if (shouldRefreshToken(ulErr)) {
              const newOauth2 = await refreshTokenForPlatform(targetPlatform)
              if (newOauth2.mfaRequired) return { success: false, mfaRequired: true, ...newOauth2 }
              targetOauth2 = newOauth2
              garminResult = await uploadGarminActivity(targetApiBase, targetOauth2, fitFile.data, fitFile.path)
            } else throw ulErr
          }
          // 佳明判定重复（409 或 202 但 uploadId 为空）：视为已同步，记为跳过
          if (garminResult?.duplicate) {
            updateSyncRecord(record._id, { status: 'skipped', errorMsg: '佳明已存在该活动' })
            result.skipped++
            continue
          }
        }

        updateSyncRecord(record._id, { status: 'success' })
        result.success++
        actualNewCount++
      } catch (err) {
        console.error(`同步活动 ${activityId} 失败:`, err.message)
        const existing = findSyncRecord({ activityId, direction, status: 'syncing' })
        if (existing) {
          updateSyncRecord(existing._id, { status: 'failed', errorMsg: err.message })
        }
        result.failed++
        result.errors.push({ activityId, activityName, error: err.message })
      }

      await new Promise(r => setTimeout(r, 1000))
    }

    // 5. 更新最后同步时间（仅用于首页展示，不再作为去重依据）
    updateLastSyncTime()

    return { success: true, data: result }
  } catch (err) {
    console.error('syncActivities error:', err)
    return { success: false, message: err.message, data: result }
  }
}
