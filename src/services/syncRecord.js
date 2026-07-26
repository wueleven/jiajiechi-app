/**
 * 同步记录服务 - 从 syncRecord 云函数迁移
 * 本地存储版本的同步记录 CRUD
 */
import {
  getSyncRecords as storageGetRecords,
  createSyncRecord,
  updateSyncRecord,
  findSyncRecord,
} from './storage.js'

export { createSyncRecord, updateSyncRecord, findSyncRecord }

/**
 * 获取同步记录（分页）
 */
export function getRecords(page = 0, pageSize = 20) {
  return storageGetRecords(page, pageSize)
}

/**
 * 获取统计信息
 */
export function getStats() {
  const result = storageGetRecords(0, 9999)
  const records = result.data || []

  return {
    success: true,
    data: {
      total: records.length,
      success: records.filter(r => r.status === 'success').length,
      failed: records.filter(r => r.status === 'failed').length,
      pending: records.filter(r => r.status === 'pending' || r.status === 'syncing').length,
    },
  }
}
