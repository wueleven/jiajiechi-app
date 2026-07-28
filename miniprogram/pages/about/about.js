// pages/about/about.js
Page({
  data: {
    appVersion: "",
    year: new Date().getFullYear(),
  },

  onLoad() {
    // 读取小程序版本号（开发版/体验版时 version 为空，回退显示"开发版"）
    let version = "";
    try {
      const accountInfo = wx.getAccountInfoSync();
      version = accountInfo.miniProgram.version || "";
    } catch (e) {
      console.warn("读取版本号失败:", e);
    }
    this.setData({ appVersion: version || "开发版" });
  },
});
