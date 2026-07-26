// pages/sync/sync.js
const app = getApp();

// 平台配对定义（固定 3 对）
const SYNC_PAIRS = [
  {
    id: "garminCn-garminCom",
    left: { key: "garminCn", label: "Garmin 国服" },
    right: { key: "garminCom", label: "Garmin 国际服" },
  },
  {
    id: "garminCn-coros",
    left: { key: "garminCn", label: "Garmin 国服" },
    right: { key: "coros", label: "COROS 高驰" },
  },
  {
    id: "garminCom-coros",
    left: { key: "garminCom", label: "Garmin 国际服" },
    right: { key: "coros", label: "COROS 高驰" },
  },
];

Page({
  data: {
    bindStatus: {
      garminCn: false,
      garminCom: false,
      coros: false,
    },
    // 可用的同步配对（根据绑定状态过滤）
    syncPairs: [],
    // 当前选中的配对 ID
    selectedPairId: "",
    // 每对的方向状态：{ [pairId]: reversed }，false=左→右，true=右→左
    pairDirections: {},
    syncing: false,
    syncProgress: {
      total: 0,
      current: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    },
    syncResult: null,
    showResult: false,
    // MFA 验证码弹窗
    showMfaModal: false,
    mfaPlatform: "",
    mfaCode: "",
    // 同步数量选项
    syncCountOptions: [
      { label: '最近 1 条', value: '1' },
      { label: '最近 5 条', value: '5' },
      { label: '最近 10 条', value: '10' },
      { label: '最近 20 条', value: '20' },
      { label: '最近 50 条', value: '50' },
      { label: '全部', value: 'all' },
    ],
    syncCountIndex: 1, // 默认选中「最近 5 条」
    syncCountLabel: '最近 5 条', // 当前选中的标签文本
    forceResync: false,
  },

  onLoad() {
    this.loadBindInfo();
  },

  onShow() {
    this.loadBindInfo();
  },

  async loadBindInfo() {
    try {
      const res = await app.getUserBindInfo();
      if (res.result && res.result.data) {
        const d = res.result.data;
        this.setData({
          bindStatus: {
            garminCn: d.garminCn ? d.garminCn.bound : false,
            garminCom: d.garminCom ? d.garminCom.bound : false,
            coros: d.coros ? d.coros.bound : false,
          },
        });
        this.buildSyncPairs();
      }
    } catch (err) {
      console.error("加载绑定信息失败:", err);
    }
  },

  /**
   * 根据绑定状态构建可用的同步配对列表
   */
  buildSyncPairs() {
    const { bindStatus } = this.data;
    const available = SYNC_PAIRS.filter(
      (p) => bindStatus[p.left.key] && bindStatus[p.right.key]
    );

    // 保留已有的方向状态
    const oldDirections = this.data.pairDirections;
    const pairDirections = {};
    available.forEach((p) => {
      pairDirections[p.id] = oldDirections[p.id] || false;
    });

    let selectedPairId = this.data.selectedPairId;
    if (!available.find((p) => p.id === selectedPairId)) {
      selectedPairId = available.length > 0 ? available[0].id : "";
    }

    this.setData({ syncPairs: available, pairDirections, selectedPairId });
  },

  /**
   * 选择配对
   */
  onPairSelect(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ selectedPairId: id });
  },

  /**
   * 切换配对方向
   */
  onSwapDirection(e) {
    const id = e.currentTarget.dataset.id;
    const key = `pairDirections.${id}`;
    this.setData({ [key]: !this.data.pairDirections[id] });
  },

  /**
   * 根据当前选中的配对和方向，生成实际的 direction 值
   */
  getCurrentDirection() {
    const { selectedPairId, syncPairs, pairDirections } = this.data;
    const pair = syncPairs.find((p) => p.id === selectedPairId);
    if (!pair) return "";

    const reversed = pairDirections[selectedPairId];
    if (reversed) {
      return pair.right.key + "To" + pair.left.key.charAt(0).toUpperCase() + pair.left.key.slice(1);
    } else {
      return pair.left.key + "To" + pair.right.key.charAt(0).toUpperCase() + pair.right.key.slice(1);
    }
  },

  /**
   * 开始同步
   */
  async startSync() {
    const direction = this.getCurrentDirection();
    if (!direction) {
      wx.showToast({ title: "请先选择同步方向", icon: "none" });
      return;
    }

    this.setData({
      syncing: true,
      showResult: false,
      syncResult: null,
      syncProgress: { total: 0, current: 0, success: 0, failed: 0, skipped: 0 },
    });

    try {
      const { syncCountOptions, syncCountIndex, forceResync } = this.data;
      const syncCount = syncCountOptions[syncCountIndex].value;

      const res = await wx.cloud.callFunction({
        name: "garminSync",
        data: { action: "syncActivities", direction, syncCount, forceResync },
      });

      if (res.result && res.result.success) {
        const result = res.result.data;
        this.setData({
          syncProgress: {
            total: result.total || 0,
            current: result.total || 0,
            success: result.success || 0,
            failed: result.failed || 0,
            skipped: result.skipped || 0,
          },
          showResult: true,
          syncResult: result,
        });
        wx.showToast({ title: "同步完成", icon: "success" });
      } else if (res.result && res.result.mfaRequired) {
        this.setData({
          showMfaModal: true,
          mfaPlatform: res.result.platform,
          mfaCode: "",
        });
      } else {
        wx.showToast({ title: res.result.message || "同步失败", icon: "none" });
      }
    } catch (err) {
      console.error("同步失败:", err);
      wx.showToast({ title: "同步失败，请重试", icon: "none" });
    } finally {
      this.setData({ syncing: false });
    }
  },

  onMfaCodeInput(e) {
    this.setData({ mfaCode: e.detail.value });
  },

  onMfaClose() {
    this.setData({ showMfaModal: false });
  },

  async onMfaSubmit() {
    const { mfaPlatform, mfaCode } = this.data;
    if (!mfaCode || mfaCode.length < 4) {
      wx.showToast({ title: "请输入验证码", icon: "none" });
      return;
    }

    this.setData({ showMfaModal: false });
    wx.showLoading({ title: "验证中..." });

    try {
      const mfaRes = await wx.cloud.callFunction({
        name: "garminAuth",
        data: { action: "submitMfa", platform: mfaPlatform, mfaCode },
      });

      wx.hideLoading();

      if (mfaRes.result && mfaRes.result.success) {
        wx.showToast({ title: "验证成功，重新同步中...", icon: "none" });
        setTimeout(() => this.startSync(), 1500);
      } else {
        wx.showToast({ title: mfaRes.result?.message || "验证失败", icon: "none" });
      }
    } catch (err) {
      wx.hideLoading();
      console.error("MFA 提交失败:", err);
      wx.showToast({ title: "验证失败，请重试", icon: "none" });
    }
  },

  goBind() {
    wx.navigateTo({ url: "/pages/bind/bind" });
  },

  goBack() {
    wx.switchTab({ url: "/pages/index/index" });
  },

  onSyncCountChange(e) {
    const idx = parseInt(e.detail.value);
    this.setData({
      syncCountIndex: idx,
      syncCountLabel: this.data.syncCountOptions[idx].label,
    });
  },

  onToggleForceResync() {
    this.setData({ forceResync: !this.data.forceResync });
  },
});
