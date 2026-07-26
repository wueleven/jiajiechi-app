// 云函数 corosSync - COROS 数据推送（Cookie 会话认证）
const cloud = require("wx-server-sdk");
const fetch = require("node-fetch");
const FormData = require("form-data");

cloud.init({ env: "cloud1-d8gyv2pt7517e6c31" });
const db = cloud.database();

// COROS API 配置
const COROS_API = {
  baseUrl: "https://www.coros.com",
  apiUrl: "https://api.coros.com",
};

/**
 * 主入口
 */
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event;

  try {
    switch (action) {
      case "uploadActivity":
        return await uploadActivity(OPENID, event);
      case "getUserInfo":
        return await getUserInfo(OPENID);
      default:
        return { success: false, message: "未知操作" };
    }
  } catch (err) {
    console.error("corosSync error:", err);
    return { success: false, message: err.message || "服务器错误" };
  }
};

/**
 * 获取 COROS 有效 session
 */
async function getValidCorosSession(openid) {
  const userRes = await db.collection("users").where({ openid }).get();
  if (userRes.data.length === 0) {
    throw new Error("用户未登录");
  }

  const user = userRes.data[0];
  const corosData = user.coros;

  if (!corosData || !corosData.bound) {
    throw new Error("COROS 未绑定");
  }

  if (corosData.expiresAt && Date.now() >= corosData.expiresAt) {
    throw new Error("COROS 登录已过期，请重新绑定账号");
  }

  return {
    cookies: corosData.sessionCookies,
    csrfToken: corosData.csrfToken || "",
  };
}

/**
 * 上传活动到 COROS
 */
async function uploadActivity(openid, event) {
  const { fitData, activityId, activityName } = event;

  if (!fitData) {
    return { success: false, message: "缺少 FIT 数据" };
  }

  try {
    const session = await getValidCorosSession(openid);

    const fitBuffer = Buffer.from(fitData, "base64");

    const form = new FormData();
    form.append("file", fitBuffer, {
      filename: `${activityId || "activity"}.fit`,
      contentType: "application/octet-stream",
    });

    const headers = {
      "Cookie": session.cookies,
      ...form.getHeaders(),
    };
    if (session.csrfToken) {
      headers["Authorization"] = `Bearer ${session.csrfToken}`;
    }

    const response = await fetch(`${COROS_API.apiUrl}/v1/activity/import`, {
      method: "POST",
      headers,
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`上传失败: ${response.status} - ${errText}`);
    }

    const result = await response.json();

    return {
      success: true,
      data: {
        corosActivityId: result.id || result.activityId,
        message: "上传成功",
      },
    };
  } catch (err) {
    console.error("uploadActivity error:", err);
    return { success: false, message: err.message };
  }
}

/**
 * 获取 COROS 用户信息
 */
async function getUserInfo(openid) {
  try {
    const session = await getValidCorosSession(openid);

    const headers = {
      "Cookie": session.cookies,
      "Accept": "application/json",
    };
    if (session.csrfToken) {
      headers["Authorization"] = `Bearer ${session.csrfToken}`;
    }

    const response = await fetch(`${COROS_API.apiUrl}/v1/user/profile`, {
      headers,
    });

    if (!response.ok) {
      throw new Error(`获取用户信息失败: ${response.status}`);
    }

    const data = await response.json();
    return { success: true, data };
  } catch (err) {
    console.error("getUserInfo error:", err);
    return { success: false, message: err.message };
  }
}
