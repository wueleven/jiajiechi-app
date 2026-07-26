<template>
  <div class="page-container">
    <!-- 记录列表 -->
    <div v-if="records.length > 0" class="record-list">
      <div v-for="record in records" :key="record._id" class="card record-card">
        <div class="record-header">
          <div class="record-name">{{ record.activityName || '未知活动' }}</div>
          <span class="tag" :class="statusClass(record.status)">{{ statusText(record.status) }}</span>
        </div>

        <div class="record-body">
          <div class="record-row">
            <span class="record-label">同步方向</span>
            <span class="record-value">{{ formatDirection(record.direction) }}</span>
          </div>
          <div class="record-row">
            <span class="record-label">活动时间</span>
            <span class="record-value">{{ record.activityTime || '-' }}</span>
          </div>
          <div class="record-row">
            <span class="record-label">同步时间</span>
            <span class="record-value">{{ formatDate(record.createdAt) }}</span>
          </div>
        </div>

        <div v-if="record.status === 'failed' && record.errorMsg" class="record-error">
          <span class="error-text">失败原因: {{ record.errorMsg }}</span>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="!loading && records.length === 0" class="empty-state">
      <div class="empty-icon-text">📋</div>
      <div class="empty-text">暂无同步记录</div>
      <div class="empty-sub">去同步页开始你的第一次数据同步吧</div>
    </div>

    <!-- 加载更多 -->
    <div v-if="loading" class="loading-more">
      <div class="loading-dot"></div>
      <span class="loading-text">加载中...</span>
    </div>

    <div v-if="!hasMore && records.length > 0" class="no-more">没有更多记录了</div>
  </div>
</template>

<script setup>
import { ref, onMounted, onActivated } from 'vue'
import { getRecords } from '../../services/syncRecord.js'

const records = ref([])
const loading = ref(false)
const hasMore = ref(true)
const page = ref(0)
const pageSize = 20

function loadRecords(refresh = false) {
  if (loading.value && !refresh) return
  const p = refresh ? 0 : page.value
  loading.value = true

  try {
    const res = getRecords(p, pageSize)
    if (res.success) {
      const newRecords = res.data || []
      records.value = refresh ? newRecords : [...records.value, ...newRecords]
      page.value = p + 1
      hasMore.value = res.hasMore !== false && newRecords.length >= pageSize
    }
  } catch (err) {
    console.error('加载记录失败:', err)
  } finally {
    loading.value = false
  }
}

const DIRECTION_MAP = {
  garminCnToGarminCom: '国服 → 国际服',
  garminComToGarminCn: '国际服 → 国服',
  garminCnToCoros: '国服 → 高驰',
  garminComToCoros: '国际服 → 高驰',
  corosToGarminCn: '高驰 → 国服',
  corosToGarminCom: '高驰 → 国际服',
}

function formatDirection(dir) { return DIRECTION_MAP[dir] || dir }

function statusText(status) {
  return { success: '成功', failed: '失败', syncing: '同步中', pending: '等待中', skipped: '跳过' }[status] || status
}

function statusClass(status) {
  return { success: 'tag-success', failed: 'tag-error', syncing: 'tag-info', pending: 'tag-info', skipped: 'tag-warning' }[status] || ''
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  try {
    return new Date(dateStr).toLocaleString('zh-CN')
  } catch { return dateStr }
}

// 下拉刷新模拟
function onPullDownRefresh() {
  loadRecords(true)
}

onMounted(() => loadRecords())
onActivated(() => loadRecords(true))

// 触底加载更多（Web 端用 scroll 事件）
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => {
    const scrollTop = document.documentElement.scrollTop || document.body.scrollTop
    const scrollHeight = document.documentElement.scrollHeight
    const clientHeight = document.documentElement.clientHeight
    if (scrollHeight - scrollTop - clientHeight < 100 && hasMore.value && !loading.value) {
      loadRecords()
    }
  })
}
</script>

<style scoped>
.page-container { padding: 12px 16px; padding-bottom: 70px; }

.record-card { padding: 16px; }
.record-header {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
}
.record-name {
  font-size: 15px; font-weight: 500; color: #333; flex: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 10px;
}
.record-body { padding-top: 10px; border-top: 1px solid #f5f5f5; }
.record-row {
  display: flex; justify-content: space-between; align-items: center; padding: 5px 0;
}
.record-label { font-size: 12px; color: #999; }
.record-value { font-size: 12px; color: #666; }

.record-error {
  margin-top: 10px; padding: 10px 12px; background: #fff1f0; border-radius: 6px;
}
.error-text { font-size: 11px; color: #ff4d4f; }

.empty-state {
  display: flex; flex-direction: column; align-items: center; padding: 80px 0;
}
.empty-icon-text { font-size: 56px; margin-bottom: 16px; }
.empty-text { font-size: 15px; color: #999; margin-bottom: 8px; }
.empty-sub { font-size: 12px; color: #ccc; }

.loading-more {
  display: flex; align-items: center; justify-content: center; padding: 16px 0;
}
.loading-dot {
  width: 14px; height: 14px; border: 2px solid #ccc; border-top-color: #0052B9;
  border-radius: 50%; margin-right: 8px; animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.loading-text { font-size: 12px; color: #999; }

.no-more { text-align: center; padding: 16px 0; font-size: 12px; color: #ccc; }
</style>
