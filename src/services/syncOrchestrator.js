/**
 * 同步编排服务 - 整合 garminSync 和 corosSync
 * 实现各方向的完整同步流程
 */
import { getPlatformApi, fetchActivities, downloadGarminActivity, uploadGarminActivity, shouldRefreshToken, refreshTokenForPlatform } from './garminSync.js'
import { getCorosSession, isCorosTokenError } from './corosAuth.js'
import { uploadToCoros, fetchCorosActivities, downloadCorosFit } from './corosSync.js'
import { createSyncRecord, updateSyncRecord, findSyncRecord } from './syncRecord.js'
import { updateLastSyncTime, getLastSyncedActTime, clearLastSyncedActTime } from './storage.js'

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
    let latestTargetActStartTime = '0'

    if (targetIsCoros) {
      corosSession = await getCorosSession()
      if (forceResync) {
        clearLastSyncedActTime(direction)
        latestTargetActStartTime = '0'
      } else {
        const lastTime = getLastSyncedActTime(direction)
        if (lastTime) {
          latestTargetActStartTime = lastTime
          console.log(`Using per-direction lastSyncedActTime: ${lastTime}`)
        }
      }
    } else {
      const targetApi = await getPlatformApi(targetPlatform)
      if (targetApi.mfaRequired) {
        return { success: false, mfaRequired: true, platform: targetApi.platform, message: targetApi.message }
      }
      targetApiBase = targetApi.apiBase
      targetOauth2 = targetApi.oauth2
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

    // 获取目标平台最新活动时间（Garmin 目标时）
    if (!targetIsCoros && !forceResync) {
      const targetActs = await fetchActivities(targetApiBase, targetOauth2, 0, 1)
      latestTargetActStartTime = targetActs[0]?.startTimeLocal ?? '0'
    }

    result.total = sourceActs.length
    const latestSourceActStartTime = sourceActs[0]?.startTimeLocal ?? '0'

    // 4. 检查是否有新活动
    if (!targetIsCoros && latestSourceActStartTime === latestTargetActStartTime) {
      return { success: true, message: '没有要同步的活动', data: result }
    }

    // 5. 倒序同步（从最早的新活动开始）
    const reversedActs = [...sourceActs].reverse()
    let actualNewCount = 1

    for (const act of reversedActs) {
      let shouldSync = false
      if (targetIsCoros) {
        if (!latestTargetActStartTime || act.startTimeLocal > latestTargetActStartTime) {
          shouldSync = true
        }
      } else {
        if (act.startTimeLocal > latestTargetActStartTime) {
          shouldSync = true
        }
      }

      if (!shouldSync) { result.skipped++; continue }

      const activityName = act.activityName || '未知活动'
      const activityId = String(act.activityId)

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
          try {
            const corosResult = await uploadToCoros(fitFile.data, fitFile.path, corosSession)
            if (corosResult?.duplicate) {
              updateSyncRecord(record._id, { status: 'skipped', errorMsg: 'COROS 已存在该活动' })
              result.skipped++
              continue
            }
            if (!corosResult?.success) {
              // 显式判失败：uploadToCoros 返回 success:false 但未 throw 的情况（如 COROS 返回非 8E16FCC7/0000）
              throw new Error(`COROS 导入未成功: ${JSON.stringify(corosResult)}`)
            }
            updateSyncRecord(record._id, { status: 'success' })
            result.success++
            actualNewCount++
          } catch (ulErr) {
            // token 失效（如 1019）则刷新 session 重试一次；仍失败则冒泡到外层标 failed
            if (isCorosTokenError(ulErr)) {
              try {
                corosSession = await getCorosSession(true)
                const retry = await uploadToCoros(fitFile.data, fitFile.path, corosSession)
                if (retry?.duplicate) {
                  updateSyncRecord(record._id, { status: 'skipped', errorMsg: 'COROS 已存在该活动' })
                  result.skipped++
                  continue
                }
                if (!retry?.success) {
                  throw new Error(`COROS 导入重试未成功: ${JSON.stringify(retry)}`)
                }
                updateSyncRecord(record._id, { status: 'success' })
                result.success++
                actualNewCount++
              } catch (retryErr) {
                throw retryErr
              }
            } else {
              throw ulErr
            }
          }
        } else {
          try {
            await uploadGarminActivity(targetApiBase, targetOauth2, fitFile.data, fitFile.path)
          } catch (ulErr) {
            // 409 = 佳明已存在该活动（重复），视为同步完成，跳过而不计为失败
            if (ulErr?.status === 409) {
              updateSyncRecord(record._id, { status: 'skipped', errorMsg: '佳明已存在该活动' })
              result.skipped++
              continue
            }
            if (shouldRefreshToken(ulErr)) {
              const newOauth2 = await refreshTokenForPlatform(targetPlatform)
              if (newOauth2.mfaRequired) return { success: false, mfaRequired: true, ...newOauth2 }
              targetOauth2 = newOauth2
              try {
                await uploadGarminActivity(targetApiBase, targetOauth2, fitFile.data, fitFile.path)
              } catch (retryErr) {
                if (retryErr?.status === 409) {
                  updateSyncRecord(record._id, { status: 'skipped', errorMsg: '佳明已存在该活动' })
                  result.skipped++
                  continue
                }
                throw retryErr
              }
            } else throw ulErr
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

    // 6. 更新同步时间
    updateLastSyncTime(
      targetIsCoros ? direction : null,
      targetIsCoros ? latestSourceActStartTime : null
    )

    return { success: true, data: result }
  } catch (err) {
    console.error('syncActivities error:', err)
    return { success: false, message: err.message, data: result }
  }
}
