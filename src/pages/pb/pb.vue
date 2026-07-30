<template>
  <div class="page-container">
    <!-- 页面顶部：返回按钮 + 标题 -->
    <div class="page-header">
      <span class="back-btn" @click="goBack">‹</span>
      <span class="page-title">跑者勋章</span>
    </div>

    <!-- 彩蛋头部 -->
    <div class="pb-hero">
      <div class="hero-emoji">🏃</div>
      <div class="hero-title">被你发现了</div>
      <div class="hero-sub">这里是作者「宵十一狼」的赛道足迹</div>
    </div>

    <!-- PB 成绩卡片 -->
    <div class="pb-card" v-for="r in records" :key="r.label" :style="cardStyle(r)">
      <div class="pb-card-top">
        <span class="pb-label">{{ r.label }}</span>
        <span class="pb-badge">PB</span>
      </div>
      <div class="pb-time">{{ r.time }}</div>
      <div class="pb-race">{{ r.race }}</div>
    </div>

    <div class="pb-note">作者正在努力训练，以求修改这个页面。</div>

    <div class="pb-footer">跑步的人总会相遇 · 佳捷驰</div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router'

const router = useRouter()

// 作者 PB 成绩（刷新 PB 后直接改这里），卡片配色取赛事印象色：杭马绿、北半马红
const records = [
  { label: '全程马拉松', race: '2025 杭州马拉松', time: '3:52:09', colors: ['#0B7A4B', '#16A968'] },
  { label: '半程马拉松', race: '2026 北京半程马拉松', time: '1:41:47', colors: ['#B01F24', '#E04A3F'] },
]

function cardStyle(r) {
  return {
    background: `linear-gradient(135deg, ${r.colors[0]}, ${r.colors[1]})`,
    boxShadow: `0 4px 14px ${r.colors[0]}40`,
  }
}

function goBack() { router.back() }
</script>

<style scoped>
.page-container { padding: 16px; padding-bottom: 70px; }
.page-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.back-btn { font-size: 28px; color: #0052B9; cursor: pointer; line-height: 1; }
.page-title { font-size: 20px; font-weight: 600; color: #333; }

.pb-hero { text-align: center; padding: 24px 0 20px; }
.hero-emoji { font-size: 44px; line-height: 1; margin-bottom: 10px; }
.hero-title { font-size: 20px; font-weight: 600; color: #333; margin-bottom: 6px; }
.hero-sub { font-size: 13px; color: #999; }

.pb-card {
  border-radius: 14px; padding: 18px 20px; margin-bottom: 14px;
}
.pb-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.pb-label { font-size: 14px; font-weight: 500; color: rgba(255,255,255,0.9); }
.pb-badge {
  font-size: 14px; font-weight: 700; color: #333;
  background: #FFD54A; border-radius: 6px; padding: 2px 10px; letter-spacing: 1px;
}
.pb-time {
  font-size: 40px; font-weight: 700; color: #fff;
  font-variant-numeric: tabular-nums; letter-spacing: 1px; margin-bottom: 10px;
}
.pb-race { font-size: 15px; color: rgba(255,255,255,0.85); }

.pb-note {
  text-align: center; font-size: 13px; color: #999;
  padding-top: 6px; line-height: 1.6;
}

.pb-footer {
  text-align: center; font-size: 12px; color: #bbb;
  padding: 20px 0 4px; line-height: 1.6;
}
</style>
