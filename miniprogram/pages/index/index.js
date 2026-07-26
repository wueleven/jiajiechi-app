// pages/index/index.js
const app = getApp();

Page({
  data: {
    bindStatus: {
      garminCn: { bound: false, displayName: "" },
      garminCom: { bound: false, displayName: "" },
      coros: { bound: false, displayName: "" },
    },
    lastSyncTime: "",
    loading: true,
  },

  onLoad() {
    this.loadBindInfo();
  },

  onShow() {
    this.loadBindInfo();
  },

  onPullDownRefresh() {
    this.loadBindInfo().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 加载用户绑定信息
   */
  async loadBindInfo() {
    this.setData({ loading: true });
    try {
      const res = await app.getUserBindInfo();
      if (res.result && res.result.data) {
        const data = res.result.data;
        this.setData({
          bindStatus: {
            garminCn: {
              bound: data.garminCn ? data.garminCn.bound : false,
              displayName: data.garminCn ? data.garminCn.displayName || "已绑定" : "",
            },
            garminCom: {
              bound: data.garminCom ? data.garminCom.bound : false,
              displayName: data.garminCom ? data.garminCom.displayName || "已绑定" : "",
            },
            coros: {
              bound: data.coros ? data.coros.bound : false,
              displayName: data.coros ? data.coros.displayName || "已绑定" : "",
            },
          },
          lastSyncTime: data.lastSyncTime || "",
        });
      }
    } catch (err) {
      console.error("加载绑定信息失败:", err);
    } finally {
      this.setData({ loading: false });
    }
  },

  /**
   * 跳转到绑定页
   */
  goBind() {
    wx.navigateTo({ url: "/pages/bind/bind" });
  },

  /**
   * 跳转到同步页
   */
  goSync() {
    wx.switchTab({ url: "/pages/sync/sync" });
  },

  /**
   * 跳转到历史记录
   */
  goHistory() {
    wx.switchTab({ url: "/pages/history/history" });
  },
});
