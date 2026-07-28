<template>
  <div class="page-container">
    <!-- 页面顶部：返回按钮 + 标题 -->
    <div class="page-header">
      <span class="back-btn" @click="goBack">‹</span>
      <span class="page-title">同步活动</span>
    </div>

    <!-- 账号绑定状态栏 -->
    <div class="bind-status-bar">
      <div class="bind-tag" :class="bindStatus.garminCn ? 'bind-ok' : 'bind-no'">
        <span class="bind-dot" :class="bindStatus.garminCn ? 'dot-ok' : 'dot-no'"></span>
        <span>Garmin 国服</span>
      </div>
      <div class="bind-tag" :class="bindStatus.garminCom ? 'bind-ok' : 'bind-no'">
        <span class="bind-dot" :class="bindStatus.garminCom ? 'dot-ok' : 'dot-no'"></span>
        <span>Garmin 国际服</span>
      </div>
      <div class="bind-tag" :class="bindStatus.coros ? 'bind-ok' : 'bind-no'">
        <span class="bind-dot" :class="bindStatus.coros ? 'dot-ok' : 'dot-no'"></span>
        <span>COROS 高驰</span>
      </div>
    </div>

    <!-- 同步方向选择 -->
    <div class="card">
      <div class="section-title">选择同步方向</div>

      <div v-if="syncPairs.length === 0" class="empty-direction">
        <div class="empty-text">暂无可用的同步方向</div>
        <div class="empty-hint">请先绑定至少两个平台账号</div>
        <div class="btn-go-bind" @click="goBind">去绑定账号</div>
      </div>

      <div v-else class="pair-list">
        <div
          v-for="pair in syncPairs" :key="pair.id"
          class="pair-card" :class="{ 'pair-selected': selectedPairId === pair.id }"
          @click="onPairSelect(pair.id)"
        >
          <div class="pair-radio">
            <div class="radio-dot" :class="{ 'radio-active': selectedPairId === pair.id }"></div>
          </div>
          <div class="pair-content">
            <span class="platform-label">{{ pairDirections[pair.id] ? pair.right.label : pair.left.label }}</span>
            <div class="swap-btn" :class="{ 'swap-active': selectedPairId === pair.id }" @click.stop="onSwapDirection(pair.id)">
              <span class="swap-arrow">⇄</span>
            </div>
            <span class="platform-label">{{ pairDirections[pair.id] ? pair.left.label : pair.right.label }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 同步按钮 -->
    <div class="sync-section">
      <div class="sync-count-row">
        <span class="sync-count-label">同步数量</span>
        <select class="sync-count-select" v-model="syncCount">
          <option value="1">最近 1 条</option>
          <option value="5">最近 5 条</option>
          <option value="10">最近 10 条</option>
          <option value="20">最近 20 条</option>
          <option value="50">最近 50 条</option>
          <option value="all">全部</option>
        </select>
      </div>
      <label class="force-resync-row">
        <input type="checkbox" v-model="forceResync" />
        <span class="force-resync-label">强制重新同步（忽略已同步记录，重新上传所有拉取到的活动）</span>
      </label>
      <button class="btn-sync" :class="{ disabled: syncing || syncPairs.length === 0 }"
        @click="startSync" :disabled="syncing || syncPairs.length === 0">
        {{ syncing ? '同步中...' : '开始同步' }}
      </button>
      <div class="sync-tip">将从源平台拉取近期活动数据并同步到目标平台</div>
    </div>

    <!-- 同步结果 -->
    <div class="card result-card" v-if="showResult">
      <div class="section-title">同步结果</div>
      <div class="result-summary">
        <div class="result-item">
          <span class="result-num">{{ syncProgress.total }}</span>
          <span class="result-label">总计</span>
        </div>
        <div class="result-item success">
          <span class="result-num">{{ syncProgress.success }}</span>
          <span class="result-label">成功</span>
        </div>
        <div class="result-item">
          <span class="result-num">{{ syncProgress.skipped }}</span>
          <span class="result-label">跳过</span>
        </div>
        <div class="result-item failed">
          <span class="result-num">{{ syncProgress.failed }}</span>
          <span class="result-label">失败</span>
        </div>
      </div>
    </div>

    <!-- 同步中遮罩 -->
    <div class="syncing-overlay" v-if="syncing">
      <div class="syncing-content">
        <div class="syncing-icon"></div>
        <div class="syncing-text">正在同步数据...</div>
        <div class="syncing-sub">请勿关闭应用</div>
      </div>
    </div>

    <!-- MFA 验证码弹窗 -->
    <div class="mfa-overlay" v-if="showMfaModal">
      <div class="mfa-modal">
        <div class="mfa-title">需要安全验证码</div>
        <div class="mfa-desc">
          {{ mfaPlatform === 'garminCn' ? '佳明国服' : '佳明国际服' }}账号需要验证身份，请输入邮箱收到的验证码
        </div>
        <input class="mfa-input" type="number" maxlength="6" placeholder="请输入验证码" v-model="mfaCode" />
        <div class="mfa-buttons">
          <button class="mfa-btn mfa-cancel" @click="showMfaModal = false">取消</button>
          <button class="mfa-btn mfa-confirm" @click="onMfaSubmit">确认</button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <div class="toast" v-if="toast.show">{{ toast.message }}</div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { getBindInfo } from '../../services/storage.js'
import { getLastSyncPrefs, saveLastSyncPrefs } from '../../services/storage.js'
import { syncActivities } from '../../services/syncOrchestrator.js'
import { submitMfa } from '../../services/garminAuth.js'

const router = useRouter()

const SYNC_PAIRS = [
  { id: 'garminCn-garminCom', left: { key: 'garminCn', label: 'Garmin 国服' }, right: { key: 'garminCom', label: 'Garmin 国际服' } },
  { id: 'garminCn-coros', left: { key: 'garminCn', label: 'Garmin 国服' }, right: { key: 'coros', label: 'COROS 高驰' } },
  { id: 'garminCom-coros', left: { key: 'garminCom', label: 'Garmin 国际服' }, right: { key: 'coros', label: 'COROS 高驰' } },
]

const bindStatus = ref({ garminCn: false, garminCom: false, coros: false })
const syncPairs = ref([])
const selectedPairId = ref('')
const pairDirections = ref({})
const syncing = ref(false)
const forceResync = ref(false)
const syncCount = ref('5')
const syncProgress = ref({ total: 0, success: 0, failed: 0, skipped: 0 })
const showResult = ref(false)
const showMfaModal = ref(false)
const mfaPlatform = ref('')
const mfaCode = ref('')
const toast = ref({ show: false, message: '' })

function showToast(msg) {
  toast.value = { show: true, message: msg }
  setTimeout(() => { toast.value.show = false }, 2500)
}

function loadBindInfo() {
  const res = getBindInfo()
  if (res.success && res.data) {
    const d = res.data
    bindStatus.value = {
      garminCn: d.garminCn?.bound || false,
      garminCom: d.garminCom?.bound || false,
      coros: d.coros?.bound || false,
    }
    buildSyncPairs()
  }
}

function buildSyncPairs() {
  const available = SYNC_PAIRS.filter(p => bindStatus.value[p.left.key] && bindStatus.value[p.right.key])
  const dirs = {}
  available.forEach(p => { dirs[p.id] = pairDirections.value[p.id] || false })

  if (!available.find(p => p.id === selectedPairId.value)) {
    // 恢复上次选择的同步方向（若存在且当前仍可用），兼容旧版存储的 direction 字段
    const last = getLastSyncPrefs()
    const lastPairId = last?.pairId || last?.direction
    const restored = lastPairId && available.find(p => p.id === lastPairId)
    selectedPairId.value = restored ? restored.id : (available.length > 0 ? available[0].id : '')
    // 恢复上次的箭头方向（是否反向）
    if (restored && typeof last.reversed === 'boolean') {
      dirs[restored.id] = last.reversed
    }
  }
  syncPairs.value = available
  pairDirections.value = dirs
}

// 保存当前同步选项（方向/数量/强制重同步），供下次进入页面恢复
function persistPrefs() {
  saveLastSyncPrefs({
    pairId: selectedPairId.value,
    reversed: !!pairDirections.value[selectedPairId.value],
    syncCount: syncCount.value,
    forceResync: forceResync.value,
  })
}

function onPairSelect(id) { selectedPairId.value = id; persistPrefs() }
function onSwapDirection(id) { pairDirections.value[id] = !pairDirections.value[id]; persistPrefs() }

// 数量/强制重同步变化时也自动记住
watch([syncCount, forceResync], persistPrefs)

function getCurrentDirection() {
  const pair = syncPairs.value.find(p => p.id === selectedPairId.value)
  if (!pair) return ''
  const reversed = pairDirections.value[selectedPairId.value]
  if (reversed) {
    return pair.right.key + 'To' + pair.left.key.charAt(0).toUpperCase() + pair.left.key.slice(1)
  }
  return pair.left.key + 'To' + pair.right.key.charAt(0).toUpperCase() + pair.right.key.slice(1)
}

async function startSync() {
  const direction = getCurrentDirection()
  if (!direction) { showToast('请先选择同步方向'); return }

  syncing.value = true
  showResult.value = false
  syncProgress.value = { total: 0, success: 0, failed: 0, skipped: 0 }

  try {
    const res = await syncActivities(direction, forceResync.value, syncCount.value)

    if (res.success) {
      syncProgress.value = {
        total: res.data?.total || 0,
        success: res.data?.success || 0,
        failed: res.data?.failed || 0,
        skipped: res.data?.skipped || 0,
      }
      showResult.value = true
      showToast('同步完成')
    } else if (res.mfaRequired) {
      showMfaModal.value = true
      mfaPlatform.value = res.platform
      mfaCode.value = ''
    } else {
      showToast(res.message || '同步失败')
    }
  } catch (err) {
    console.error('同步失败:', err)
    showToast('同步失败，请重试')
  } finally {
    syncing.value = false
  }
}

async function onMfaSubmit() {
  if (!mfaCode.value || mfaCode.value.length < 4) { showToast('请输入验证码'); return }
  showMfaModal.value = false
  showToast('验证中...')

  try {
    const mfaRes = await submitMfa(mfaPlatform.value, mfaCode.value)
    if (mfaRes.success) {
      showToast('验证成功，重新同步中...')
      setTimeout(() => startSync(), 1500)
    } else {
      showToast(mfaRes.message || '验证失败')
    }
  } catch (err) {
    showToast('验证失败，请重试')
  }
}

function goBind() { router.push('/bind') }
function goBack() { router.push('/index') }

function restorePrefs() {
  const last = getLastSyncPrefs()
  if (!last) return
  if (last.syncCount) syncCount.value = String(last.syncCount)
  if (typeof last.forceResync === 'boolean') forceResync.value = last.forceResync
}

onMounted(() => { restorePrefs(); loadBindInfo() })
onActivated(loadBindInfo)
</script>

<style scoped>
.page-container { padding: 16px; padding-bottom: 70px; }
.page-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.back-btn { font-size: 28px; color: #0052B9; cursor: pointer; line-height: 1; }
.page-title { font-size: 20px; font-weight: 600; color: #333; }

.bind-status-bar { display: flex; gap: 6px; margin-bottom: 14px; }
.bind-tag { flex: 1; min-width: 0; justify-content: center; display: flex; align-items: center; gap: 5px; padding: 5px 4px; border-radius: 20px; font-size: 11px; box-sizing: border-box; white-space: nowrap; }
.bind-ok { background: #f0fff4; color: #389e0d; }
.bind-no { background: #f5f5f5; color: #999; }
.bind-dot { width: 7px; height: 7px; border-radius: 50%; }
.dot-ok { background: #52c41a; }
.dot-no { background: #ccc; }

.pair-list { display: flex; flex-direction: column; gap: 10px; }
.pair-card {
  display: flex; align-items: center; padding: 16px 14px;
  border-radius: 12px; background: #f8f9fa; border: 2px solid transparent; cursor: pointer;
}
.pair-selected { background: #f0f5ff; border-color: #0052B9; }
.pair-radio {
  width: 20px; height: 20px; border-radius: 50%; border: 2px solid #ccc;
  display: flex; align-items: center; justify-content: center; margin-right: 12px; flex-shrink: 0;
}
.pair-selected .pair-radio { border-color: #0052B9; }
.radio-dot { width: 0; height: 0; border-radius: 50%; background: transparent; transition: all 0.2s; }
.radio-active { width: 10px; height: 10px; background: #0052B9; }
.pair-content { flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px; }
.platform-label { font-size: 13px; color: #333; font-weight: 500; white-space: nowrap; }
.swap-btn {
  width: 36px; height: 36px; border-radius: 50%; background: #e8edf5;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.swap-active { background: #0052B9; }
.swap-arrow { font-size: 18px; color: #666; }
.swap-active .swap-arrow { color: #fff; }

.empty-direction { text-align: center; padding: 24px 0; }
.empty-text { font-size: 14px; color: #999; margin-bottom: 8px; }
.empty-hint { font-size: 12px; color: #ccc; margin-bottom: 14px; }
.btn-go-bind {
  display: inline-block; background: #0052B9; color: #fff;
  padding: 8px 24px; border-radius: 8px; font-size: 13px; cursor: pointer;
}

.sync-section { margin: 20px 0; text-align: center; }
.sync-count-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-bottom: 12px;
  padding: 10px 14px; background: #f8f9fa; border-radius: 10px;
}
.sync-count-label { font-size: 14px; color: #333; font-weight: 500; }
.sync-count-select {
  flex: 1; max-width: 180px;
  padding: 6px 10px; font-size: 14px;
  border: 1px solid #e0e0e0; border-radius: 6px;
  background: #fff; color: #333; cursor: pointer;
  outline: none;
}
.sync-count-select:focus { border-color: #0052B9; }
.force-resync-row {
  display: flex; align-items: flex-start; gap: 8px;
  font-size: 12px; color: #666; text-align: left;
  margin-bottom: 12px; cursor: pointer;
}
.force-resync-row input { margin-top: 2px; cursor: pointer; }
.force-resync-label { line-height: 1.5; }
.btn-sync {
  background: #0052B9; color: #fff; border-radius: 12px; padding: 14px 0;
  font-size: 16px; font-weight: 600; width: 100%; border: none; cursor: pointer;
}
.btn-sync.disabled { background: #ccc; color: #999; }
.sync-tip { font-size: 11px; color: #999; margin-top: 10px; }

.result-card { margin-top: 16px; }
.result-summary { display: flex; justify-content: space-around; padding: 12px 0; }
.result-item { text-align: center; }
.result-num { display: block; font-size: 26px; font-weight: 600; color: #333; margin-bottom: 4px; }
.success .result-num { color: #52c41a; }
.failed .result-num { color: #ff4d4f; }
.result-label { font-size: 12px; color: #999; }

.syncing-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6); display: flex; align-items: center;
  justify-content: center; z-index: 1000;
}
.syncing-content { text-align: center; color: #fff; }
.syncing-icon {
  width: 44px; height: 44px; border: 3px solid rgba(255,255,255,0.3);
  border-top-color: #fff; border-radius: 50%; margin: 0 auto 16px;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.syncing-text { font-size: 16px; font-weight: 500; margin-bottom: 8px; }
.syncing-sub { font-size: 12px; opacity: 0.7; }

.mfa-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5); display: flex; align-items: center;
  justify-content: center; z-index: 1000;
}
.mfa-modal { width: 85%; max-width: 400px; background: #fff; border-radius: 16px; padding: 28px 24px; }
.mfa-title { font-size: 17px; font-weight: 600; text-align: center; margin-bottom: 12px; }
.mfa-desc { font-size: 13px; color: #666; text-align: center; margin-bottom: 20px; line-height: 1.5; }
.mfa-input {
  width: 100%; height: 48px; border: 1px solid #ddd; border-radius: 8px;
  text-align: center; font-size: 20px; letter-spacing: 8px; margin-bottom: 20px; outline: none;
}
.mfa-input:focus { border-color: #0052B9; }
.mfa-buttons { display: flex; gap: 14px; }
.mfa-btn {
  flex: 1; height: 44px; border-radius: 8px; font-size: 14px;
  text-align: center; border: none; cursor: pointer;
}
.mfa-cancel { background: #f5f5f5; color: #666; }
.mfa-confirm { background: #0052B9; color: #fff; }

.toast {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: rgba(0,0,0,0.75); color: #fff; padding: 10px 24px;
  border-radius: 8px; font-size: 14px; z-index: 2000;
}
</style>
