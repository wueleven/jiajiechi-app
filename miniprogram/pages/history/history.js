// pages/history/history.js
const app = getApp();

Page({
  data: {
    records: [],
    loading: true,
    hasMore: true,
    page: 0,
    pageSize: 20,
  },

  onLoad() {
    this.loadRecords();
  },

  onShow() {
    this.loadRecords(true);
  },

  onPullDownRefresh() {
    this.loadRecords(true).then(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.loadRecords();
    }
  },

  /**
   * 加载同步记录
   */
  async loadRecords(refresh = false) {
    if (this.data.loading && !refresh) return;

    const page = refresh ? 0 : this.data.page;
    this.setData({ loading: true });

    try {
      const res = await wx.cloud.callFunction({
        name: "syncRecord",
        data: {
          action: "getRecords",
          page: page,
          pageSize: this.data.pageSize,
        },
      });

      if (res.result && res.result.success) {
        console.log('loadRecords raw data:', JSON.stringify(res.result.data).substring(0, 500));
        const newRecords = (res.result.data || []).map(r => ({
          ...r,
          createdAtFormatted: this.formatDate(r.createdAt),
        }));
        console.log('loadRecords formatted:', newRecords.length, 'records');
        const records = refresh ? newRecords : [...this.data.records, ...newRecords];
        this.setData({
          records: records,
          page: page + 1,
          hasMore: newRecords.length >= this.data.pageSize,
        });
      }
    } catch (err) {
      console.error("加载记录失败:", err);
      console.error("错误详情:", err.message, err.errMsg);
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 格式化同步方向
   */
  formatDirection(direction) {
    const map = {
      garminCnToGarminCom: "国服 → 国际服",
      garminComToGarminCn: "国际服 → 国服",
      garminCnToCoros: "国服 → 高驰",
      garminComToCoros: "国际服 → 高驰",
      corosToGarminCn: "高驰 → 国服",
      corosToGarminCom: "高驰 → 国际服",
    };
    return map[direction] || direction;
  },

  /**
   * 格式化状态
   */
  formatStatus(status) {
    const map = {
      pending: "等待中",
      syncing: "同步中",
      success: "成功",
      failed: "失败",
      skipped: "跳过",
    };
    return map[status] || status;
  },

  formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return String(dateStr);
      const pad = (n) => { const s = String(n); return s.length < 2 ? '0' + s : s; };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    } catch { return String(dateStr); }
  },
});
