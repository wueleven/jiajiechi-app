// pages/bind/bind.js
const app = getApp();

Page({
  data: {
    garminCn: { bound: false, displayName: "", loading: false },
    garminCom: { bound: false, displayName: "", loading: false },
    coros: { bound: false, displayName: "", loading: false },
    showBindModal: false,
    showMfaModal: false,
    currentPlatform: "",
    currentPlatformName: "",
    username: "",
    password: "",
    mfaCode: "",
    loginLoading: false,
    mfaLoading: false,
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
          garminCn: {
            bound: d.garminCn ? d.garminCn.bound : false,
            displayName: d.garminCn ? d.garminCn.displayName || "已绑定" : "",
          },
          garminCom: {
            bound: d.garminCom ? d.garminCom.bound : false,
            displayName: d.garminCom ? d.garminCom.displayName || "已绑定" : "",
          },
          coros: {
            bound: d.coros ? d.coros.bound : false,
            displayName: d.coros ? d.coros.displayName || "已绑定" : "",
          },
        });
      }
    } catch (err) {
      console.error("加载绑定信息失败:", err);
    }
  },

  onGarminCnTap() {
    if (this.data.garminCn.bound) {
      this.confirmUnbind("garminCn", "Garmin 国服");
    } else {
      this.openBindModal("garminCn", "Garmin 国服");
    }
  },

  onGarminComTap() {
    if (this.data.garminCom.bound) {
      this.confirmUnbind("garminCom", "Garmin 国际服");
    } else {
      this.openBindModal("garminCom", "Garmin 国际服");
    }
  },

  onCorosTap() {
    if (this.data.coros.bound) {
      this.confirmUnbind("coros", "COROS 高驰");
    } else {
      this.openBindModal("coros", "COROS 高驰");
    }
  },

  openBindModal(platform, name) {
    this.setData({
      showBindModal: true,
      currentPlatform: platform,
      currentPlatformName: name,
      username: "",
      password: "",
      loginLoading: false,
    });
  },

  closeBindModal() {
    this.setData({ showBindModal: false, username: "", password: "" });
  },

  onUsernameInput(e) {
    this.setData({ username: e.detail.value });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  async submitLogin() {
    const { currentPlatform, username, password, currentPlatformName } = this.data;
    if (!username.trim() || !password.trim()) {
      wx.showToast({ title: "请输入账号和密码", icon: "none" });
      return;
    }

    this.setData({ loginLoading: true });

    try {
      let res;
      if (currentPlatform === "coros") {
        // COROS 走独立绑定流程
        res = await wx.cloud.callFunction({
          name: "garminAuth",
          data: {
            action: "corosBind",
            email: username.trim(),
            password: password.trim(),
          },
        });
      } else {
        // Garmin 走 SSO 登录流程
        const region = currentPlatform === "garminCn" ? "cn" : "com";
        res = await wx.cloud.callFunction({
          name: "garminAuth",
          data: {
            action: "bindWithPassword",
            platform: currentPlatform,
            region: region,
            username: username.trim(),
            password: password.trim(),
          },
        });
      }

      if (res.result && res.result.success) {
        if (res.result.mfaRequired) {
          // 仅 Garmin 会触发 MFA
          this.setData({
            showBindModal: false,
            showMfaModal: true,
            mfaCode: "",
            mfaLoading: false,
          });
          return;
        }
        wx.showToast({ title: `${currentPlatformName} 绑定成功`, icon: "success" });
        this.setData({
          showBindModal: false,
          username: "",
          password: "",
          [`${currentPlatform}.bound`]: true,
          [`${currentPlatform}.displayName`]: res.result.data?.displayName || username.trim(),
        });
        setTimeout(() => this.loadBindInfo(), 1500);
      } else {
        wx.showToast({ title: res.result.message || "绑定失败", icon: "none" });
      }
    } catch (err) {
      console.error("绑定失败:", err);
      wx.showToast({ title: "绑定失败，请重试", icon: "none" });
    } finally {
      this.setData({ loginLoading: false });
    }
  },

  onMfaCodeInput(e) {
    this.setData({ mfaCode: e.detail.value });
  },

  closeMfaModal() {
    this.setData({ showMfaModal: false, mfaCode: "" });
  },

  async submitMfaCode() {
    const { currentPlatform, mfaCode, currentPlatformName } = this.data;
    if (!mfaCode.trim()) {
      wx.showToast({ title: "请输入验证码", icon: "none" });
      return;
    }

    this.setData({ mfaLoading: true });

    try {
      const res = await wx.cloud.callFunction({
        name: "garminAuth",
        data: {
          action: "submitMfa",
          platform: currentPlatform,
          mfaCode: mfaCode.trim(),
        },
      });

      if (res.result && res.result.success) {
        wx.showToast({ title: `${currentPlatformName} 绑定成功`, icon: "success" });
        this.setData({
          showMfaModal: false,
          mfaCode: "",
          [`${currentPlatform}.bound`]: true,
          [`${currentPlatform}.displayName`]: res.result.data?.displayName || "",
        });
        setTimeout(() => this.loadBindInfo(), 1500);
      } else {
        wx.showToast({ title: res.result.message || "验证码错误", icon: "none" });
      }
    } catch (err) {
      console.error("MFA 提交失败:", err);
      wx.showToast({ title: "验证失败，请重试", icon: "none" });
    } finally {
      this.setData({ mfaLoading: false });
    }
  },

  confirmUnbind(platform, name) {
    wx.showModal({
      title: "确认解绑",
      content: `确定要解绑 ${name} 吗？解绑后需要重新登录才能同步数据。`,
      confirmColor: "#ff4d4f",
      success: async (res) => {
        if (res.confirm) {
          await this.doUnbind(platform, name);
        }
      },
    });
  },

  async doUnbind(platform, name) {
    wx.showLoading({ title: "解绑中..." });
    try {
      const res = await wx.cloud.callFunction({
        name: "garminAuth",
        data: { action: "unbind", platform: platform },
      });

      if (res.result && res.result.success) {
        wx.showToast({ title: `${name} 已解绑`, icon: "success" });
        this.setData({
          [`${platform}.bound`]: false,
          [`${platform}.displayName`]: "",
        });
      } else {
        wx.showToast({ title: "解绑失败", icon: "none" });
      }
    } catch (err) {
      console.error("解绑失败:", err);
      wx.showToast({ title: "解绑失败，请重试", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },

  goBack() {
    wx.navigateBack();
  },
});
