// app.js
App({
  onLaunch: function () {
    this.globalData = {
      env: "cloud1-d8gyv2pt7517e6c31",
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    }
  },

  globalData: {
    env: "cloud1-d8gyv2pt7517e6c31",
    userInfo: null,
  },

  /**
   * 获取用户绑定信息
   */
  getUserBindInfo() {
    return wx.cloud.callFunction({
      name: "garminAuth",
      data: { action: "getBindInfo" },
    });
  },
});
