// 云函数 garminSync - 完全参照 dailysync-rev 开源项目的同步逻辑
// 直接用 OAuth token 调用 Garmin API，不依赖 @gooin/garmin-connect 库

// === Polyfill: AWS SDK v3 / JSZip 在微信云函数环境中需要 Web Crypto API ===
// 必须在 require("@aws-sdk/client-s3") 和 require("jszip") 之前执行
try {
  const { webcrypto } = require("crypto");
  if (webcrypto) {
    // Node.js 15+ 提供 webcrypto，是完整的 Web Crypto API（含 getRandomValues）
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    if (!globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
    // 同时设置到 global 和 self，兼容不同检测逻辑
    if (typeof global !== "undefined" && !global.crypto) global.crypto = webcrypto;
    if (typeof self !== "undefined" && !self.crypto) self.crypto = webcrypto;
    console.log("crypto polyfill: using webcrypto");
  } else {
    throw new Error("webcrypto not available");
  }
} catch (e) {
  // 降级：手动 polyfill getRandomValues
  console.log("crypto polyfill: using fallback randomFillSync");
  const nodeCrypto = require("crypto");
  const polyfill = { getRandomValues: (buf) => nodeCrypto.randomFillSync(buf) };
  globalThis.crypto = polyfill;
  if (typeof global !== "undefined") global.crypto = polyfill;
}

const cloud = require("wx-server-sdk");
const axios = require("axios");
const FormData = require("form-data");
const decompress = require("decompress");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");
const qs = require("qs");
const JSZip = require("jszip");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

cloud.init({ env: "cloud1-d8gyv2pt7517e6c31" });
const db = cloud.database();

// 每次同步的最大活动数（微信云函数 60 秒超时限制，10 条约 45 秒可完成）
const DEFAULT_SYNC_NUM = 10;
// OAuth consumer 地址（与 garminAuth 相同）
const OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
const USER_AGENT = "com.garmin.android.apps.connectmobile";

// COROS 区域配置（参照 garmin-sync-coros 开源项目）
// 登录统一使用 teamcnapi.coros.com，登录后由 regionId 路由到正确的 API
const COROS_LOGIN_API = "https://teamcnapi.coros.com";
const COROS_REGION_CONFIG = {
  1: { teamapi: "https://teamapi.coros.com",    bucket: "coros-s3",  service: "aws",    s3Endpoint: "https://s3.us-east-1.amazonaws.com" },
  2: { teamapi: "https://teamcnapi.coros.com",  bucket: "coros-oss",  service: "aliyun", s3Endpoint: "https://oss-cn-beijing.aliyuncs.com" },
  3: { teamapi: "https://teameuapi.coros.com",  bucket: "eu-coros",   service: "aws",    s3Endpoint: "https://s3.eu-central-1.amazonaws.com" },
};
// COROS STS 凭证获取配置（不同区域 sign 不同）
const COROS_FAQ_API = "https://faq.coros.com";
const COROS_S3_SALT = "9y78gpoERW4lBNYL";
const COROS_APP_ID = "1660188068672619112";
const COROS_STS_SIGN = {
  1: "E34EF0E34A498A54A9C3EAEFC12B7CAF",  // US/AWS
  2: "9AD4AA35AAFEE6BB1E847A76848D58DF",  // CN/Aliyun
  3: "877571111A1EE5316E4B590103D4B5B3",  // EU/AWS
};

/**
 * 主入口
 */
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event;

  try {
    switch (action) {
      case "syncActivities":
        return await syncActivities(OPENID, event);
      case "getActivities":
        return await getActivities(OPENID, event);
      case "getActivityDetail":
        return await getActivityDetail(OPENID, event);
      default:
        return { success: false, message: "未知操作" };
    }
  } catch (err) {
    console.error("garminSync error:", err);
    return { success: false, message: err.message || "服务器错误" };
  }
};

// ==================== API 客户端 ====================

/**
 * 根据平台获取 API 基础 URL 和 OAuth token（带自动刷新）
 */
async function getPlatformApi(openid, platform) {
  const userRes = await db.collection("users").where({ openid }).get();
  if (userRes.data.length === 0) {
    throw new Error("用户未绑定");
  }

  const user = userRes.data[0];
  const platformData = user[platform];

  if (!platformData || !platformData.bound) {
    const name = platform === "garminCn" ? "佳明国服" : "佳明国际服";
    throw new Error(`${name} 未绑定`);
  }

  if (!platformData.oauth1 || !platformData.oauth2) {
    throw new Error("登录凭证缺失，请重新绑定");
  }

  const domain = platform === "garminCn" ? "garmin.cn" : "garmin.com";
  const apiBase = `https://connectapi.${domain}`;

  // 检查 token 是否过期或即将过期（提前 5 分钟刷新），过期则自动刷新
  let oauth2 = platformData.oauth2;
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = oauth2.expires_at ? oauth2.expires_at - now : 0;
  console.log(`${platform}: token expires_in=${expiresIn}s, has_expires_at=${!!oauth2.expires_at}, access_token_len=${(oauth2.access_token||'').length}`);

  if (!oauth2.expires_at || now >= oauth2.expires_at - 300) {
    console.log(`${platform}: OAuth2 token needs refresh (expires_in=${expiresIn}s)`);
    try {
      oauth2 = await refreshOauth2Token(platformData.oauth1, apiBase);
      // 更新数据库中的 token
      const docId = userRes.data[0]._id;
      await db.collection("users").doc(docId).update({
        data: { [`${platform}.oauth2`]: oauth2 },
      });
      console.log(`${platform}: OAuth2 token refreshed successfully, new expires_in=${oauth2.expires_in}s`);
    } catch (refreshErr) {
      console.error(`${platform}: token refresh failed:`, refreshErr.message);
      // 尝试自动重新登录
      if (platform.startsWith("garmin") && platformData.password) {
        console.log(`${platform}: trying autoRelogin...`);
        const reloginRes = await cloud.callFunction({
          name: "garminAuth",
          data: { action: "autoRelogin", platform },
        });
        const result = reloginRes.result;
        if (result && result.success) {
          // 重新读取最新的 token
          const freshUserRes = await db.collection("users").where({ openid }).get();
          oauth2 = freshUserRes.data[0][platform].oauth2;
          console.log(`${platform}: autoRelogin success`);
        } else if (result && result.mfaRequired) {
          // 返回 mfaRequired 特殊标记
          return { mfaRequired: true, platform, message: result.message };
        } else {
          const platformName = platform === "garminCn" ? "佳明国服" : "佳明国际服";
          throw new Error(`${platformName}登录凭证已失效，请在绑定页面重新登录后再试`);
        }
      } else {
        const platformName = platform === "garminCn" ? "佳明国服" : "佳明国际服";
        throw new Error(`${platformName}登录凭证已失效，请在绑定页面重新登录后再试`);
      }
    }
  } else {
    console.log(`${platform}: token still valid, no refresh needed`);
  }

  return {
    apiBase,
    oauth1: platformData.oauth1,
    oauth2,
    displayName: platformData.displayName || "",
  };
}

/**
 * 用 OAuth1 重新换取新的 OAuth2 token
 */
async function refreshOauth2Token(oauth1, apiBase) {
  const consumerRes = await axios.get(OAUTH_CONSUMER_URL);
  const consumer = { key: consumerRes.data.consumer_key, secret: consumerRes.data.consumer_secret };
  const oauth = new OAuth({
    consumer,
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });

  const oauthUrl = `${apiBase}/oauth-service/oauth`;
  const exchangeUrl = `${oauthUrl}/exchange/user/2.0`;
  const oauthToken = { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret };
  const requestData = { url: exchangeUrl, method: "POST", data: null };
  const authData = oauth.authorize(requestData, oauthToken);
  const url = `${exchangeUrl}?${qs.stringify(authData)}`;

  const res = await axios.post(url, null, {
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const oauth2 = res.data;
  oauth2.expires_at = Math.floor(Date.now() / 1000) + oauth2.expires_in;
  return oauth2;
}

/**
 * 创建带 OAuth2 Bearer 认证的 axios 实例
 */
function createApiClient(apiBase, oauth2) {
  return axios.create({
    baseURL: apiBase,
    headers: {
      Authorization: `Bearer ${oauth2.access_token}`,
      "User-Agent": "com.garmin.android.apps.connectmobile",
    },
    timeout: 30000,
  });
}

/**
 * 验证 OAuth token 是否有效（对应参考项目的 getUserProfile 验证）
 */
async function validateToken(apiClient) {
  const res = await apiClient.get("/userprofile-service/socialProfile");
  return res.data;
}

/**
 * 判断是否需要刷新 token（403 认证失败，或 5xx 服务器端会话失效）
 */
function shouldRefreshToken(err) {
  const status = err.response?.status;
  return status === 401 || status === 403 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * 刷新 token 并重试 validateToken（带一次延迟重试）
 */
async function refreshTokenAndRetryValidation(apiClient, platform, openid) {
  // 获取平台 API 信息用于刷新
  const apiBase = apiClient.defaults.baseURL;
  const userRes = await db.collection("users").where({ openid }).get();
  const platformData = userRes.data[0][platform];

  console.log(`Refreshing ${platform} token due to server error...`);
  let newOauth2;
  try {
    newOauth2 = await refreshOauth2Token(platformData.oauth1, apiBase);
  } catch (refreshErr) {
    // OAuth1 刷新失败，尝试用保存的账号密码自动重新登录
    console.log(`OAuth1 refresh failed (${refreshErr.message}), trying autoRelogin...`);
    const reloginRes = await cloud.callFunction({
      name: "garminAuth",
      data: { action: "autoRelogin", platform },
    });
    const result = reloginRes.result;
    if (result && result.success) {
      console.log(`autoRelogin success for ${platform}`);
      // 重新读取最新的 token
      const freshUserRes = await db.collection("users").where({ openid }).get();
      const freshData = freshUserRes.data[0][platform];
      newOauth2 = freshData.oauth2;
    } else if (result && result.mfaRequired) {
      // 需要 MFA 验证码，返回特殊标记让前端处理
      return { mfaRequired: true, platform, message: result.message };
    } else {
      throw new Error(result?.message || "自动重新登录失败");
    }
  }

  if (newOauth2) {
    const docId = userRes.data[0]._id;
    await db.collection("users").doc(docId).update({
      data: { [`${platform}.oauth2`]: newOauth2 },
    });
    apiClient.defaults.headers.common["Authorization"] = `Bearer ${newOauth2.access_token}`;
  }

  try {
    return await validateToken(apiClient);
  } catch (retryErr) {
    // 刷新后仍然失败，等待 2 秒再试一次（应对短暂服务器不可用）
    const status = retryErr.response?.status;
    console.log(`Token refresh retry still failed (${status}), waiting 2s...`);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      return await validateToken(apiClient);
    } catch (finalErr) {
      // 所有重试都失败，提示用户可能需要重新绑定
      const platformName = platform === "garminCn" ? "佳明国服" : "佳明国际服";
      throw new Error(`${platformName}会话已失效，请在绑定页面重新登录后再试`);
    }
  }
}

// ==================== Garmin API 操作（对应 garmin_common.ts） ====================

/**
 * 获取活动列表（对应 client.getActivities）
 */
async function fetchActivities(apiClient, start = 0, limit = 20) {
  const res = await apiClient.get("/activitylist-service/activities/search/activities", {
    params: { start, limit },
  });
  return res.data;
}

/**
 * 获取活动详情（对应 client.getActivity）
 */
async function fetchActivity(apiClient, activityId) {
  const res = await apiClient.get(`/activity-service/activity/${activityId}`);
  return res.data;
}

/**
 * 下载 garmin 活动原始数据，解压并返回 FIT 文件 Buffer
 * 对应参考项目的 downloadGarminActivity
 */
async function downloadGarminActivity(apiClient, activityId) {
  // 下载 zip 文件
  const zipRes = await apiClient.get(`/download-service/files/activity/${activityId}`, {
    responseType: "arraybuffer",
  });
  const zipBuffer = Buffer.from(zipRes.data);
  console.log(`downloadGarminActivity: zip size = ${zipBuffer.length} bytes`);

  // 解压 zip（对应参考项目的 decompress）
  const files = await decompress(zipBuffer);
  if (!files || files.length === 0) {
    throw new Error("解压失败：zip 文件为空");
  }

  // 返回第一个文件（通常是 .fit 文件）
  const fitFile = files[0];
  console.log(`downloadGarminActivity: extracted ${fitFile.path}, size = ${fitFile.data.length} bytes`);
  return { path: fitFile.path, data: fitFile.data };
}

/**
 * 上传 FIT 文件到 Garmin（对应参考项目的 uploadGarminActivity）
 */
async function uploadGarminActivity(apiClient, fitData, filename) {
  const form = new FormData();
  form.append("userfile", fitData, {
    filename: filename || "activity.fit",
    contentType: "application/octet-stream",
  });

  const res = await apiClient.post("/upload-service/upload/fit", form, {
    headers: {
      ...form.getHeaders(),
      Authorization: apiClient.defaults.headers.common["Authorization"],
    },
    maxBodyLength: 10 * 1024 * 1024,
    maxContentLength: 10 * 1024 * 1024,
  });
  console.log("upload to garmin activity:", JSON.stringify(res.data).substring(0, 200));
  return res.data;
}

// ==================== 同步逻辑（完全对应 syncGarminCN2GarminGlobal） ====================

/**
 * 同步活动（对应 syncGarminCN2GarminGlobal / syncGarminGlobal2GarminCN）
 */
async function syncActivities(openid, event) {
  const { direction, forceResync, syncCount } = event;

  // 解析同步数量：支持数字字符串或 'all'
  const fetchAll = syncCount === 'all';
  const syncLimit = fetchAll ? 999 : (Math.max(1, parseInt(syncCount, 10)) || DEFAULT_SYNC_NUM);

  if (!direction) {
    return { success: false, message: "请指定同步方向" };
  }

  let sourcePlatform = "";
  let targetPlatform = "";
  let targetIsCoros = false;
  let sourceIsCoros = false;

  if (direction === "garminCnToGarminCom") {
    sourcePlatform = "garminCn";
    targetPlatform = "garminCom";
  } else if (direction === "garminComToGarminCn") {
    sourcePlatform = "garminCom";
    targetPlatform = "garminCn";
  } else if (direction === "garminCnToCoros") {
    sourcePlatform = "garminCn";
    targetIsCoros = true;
  } else if (direction === "garminComToCoros") {
    sourcePlatform = "garminCom";
    targetIsCoros = true;
  } else if (direction === "corosToGarminCn") {
    sourceIsCoros = true;
    targetPlatform = "garminCn";
  } else if (direction === "corosToGarminCom") {
    sourceIsCoros = true;
    targetPlatform = "garminCom";
  } else {
    return { success: false, message: "暂不支持该同步方向" };
  }

  const result = {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  try {
    // 获取源平台客户端
    let sourceApi = null;
    let sourceClient = null;
    let sourceCorosSession = null;

    if (sourceIsCoros) {
      // COROS 源：获取 COROS session
      console.log("syncActivities: COROS source, direction=", direction);
      sourceCorosSession = await getCorosSession(openid);
      console.log(`COROS source session obtained: userId=${sourceCorosSession.userId}, regionId=${sourceCorosSession.regionId}`);
    } else {
      // Garmin 源：获取 Garmin API 客户端
      sourceApi = await getPlatformApi(openid, sourcePlatform);
      // 检查是否需要 MFA 验证
      if (sourceApi.mfaRequired) {
        return { success: false, mfaRequired: true, platform: sourceApi.platform, message: sourceApi.message };
      }
      sourceClient = createApiClient(sourceApi.apiBase, sourceApi.oauth2);

      // 验证源 token
      console.log("syncActivities: start, direction=", direction, "targetIsCoros=", targetIsCoros);
      console.log("Validating source token...");
      let sourceProfile;
      try {
        sourceProfile = await validateToken(sourceClient);
      } catch (err) {
        console.error("Source token validation failed:", err.response?.status, err.message);
        if (shouldRefreshToken(err)) {
          sourceProfile = await refreshTokenAndRetryValidation(sourceClient, sourcePlatform, openid);
          // 检查是否需要 MFA 验证
          if (sourceProfile && sourceProfile.mfaRequired) {
            return { success: false, mfaRequired: true, platform: sourceProfile.platform, message: sourceProfile.message };
          }
        } else {
          throw err;
        }
      }
      console.log(`Source user: ${sourceProfile.fullName || sourceProfile.userName}`);
    }

    // 获取目标平台信息（Garmin 或 COROS）
    let targetClient = null;
    let targetApi = null;
    let corosSession = null;
    let latestTargetActStartTime = "0";

    if (targetIsCoros) {
      // COROS 目标：获取 COROS session
      corosSession = await getCorosSession(openid);
      console.log("COROS session obtained successfully");

      // COROS 无法直接查询最近活动，使用按方向存储的最后同步活动时间来判断
      if (forceResync) {
        // 强制重新同步：清除该方向的 lastSyncedActTime，所有活动重新上传
        const directionKey = `lastSyncedActTime_${direction}`;
        await db.collection("users").where({ openid }).update({
          data: { [directionKey]: db.command.remove() },
        });
        latestTargetActStartTime = "0";
        console.log("forceResync=true: cleared lastSyncedActTime, will re-sync all activities");
      } else {
        const userRes = await db.collection("users").where({ openid }).get();
        if (userRes.data.length > 0) {
          const directionKey = `lastSyncedActTime_${direction}`;
          const lastSyncedActTime = userRes.data[0][directionKey];
          if (lastSyncedActTime) {
            latestTargetActStartTime = lastSyncedActTime;
            console.log(`Using per-direction lastSyncedActTime as COROS baseline: ${lastSyncedActTime}`);
          }
        }
      }
    } else {
      // Garmin 目标：获取目标 Garmin API 客户端
      targetApi = await getPlatformApi(openid, targetPlatform);
      // 检查是否需要 MFA 验证
      if (targetApi.mfaRequired) {
        return { success: false, mfaRequired: true, platform: targetApi.platform, message: targetApi.message };
      }
      targetClient = createApiClient(targetApi.apiBase, targetApi.oauth2);

      console.log("Validating target token...");
      let targetProfile;
      try {
        targetProfile = await validateToken(targetClient);
      } catch (err) {
        console.error("Target token validation failed:", err.response?.status, err.message);
        if (shouldRefreshToken(err)) {
          targetProfile = await refreshTokenAndRetryValidation(targetClient, targetPlatform, openid);
          // 检查是否需要 MFA 验证
          if (targetProfile && targetProfile.mfaRequired) {
            return { success: false, mfaRequired: true, platform: targetProfile.platform, message: targetProfile.message };
          }
        } else {
          throw err;
        }
      }
      console.log(`Target user: ${targetProfile.fullName || targetProfile.userName}`);
    }

    // 拉取源平台最近活动
    let sourceActs;
    if (sourceIsCoros) {
      // COROS API 对 pageSize 有严格限制，固定每页 20 条分页拉取，直到拉够或没有更多
      try {
        sourceActs = await fetchCorosActivitiesUpTo(sourceCorosSession, fetchAll ? Infinity : syncLimit);
      } catch (err) {
        // COROS token 在服务端失效，强制刷新 token 后重试一次
        if (err.message && err.message.includes("Access token is invalid")) {
          console.log("COROS access token invalid, forcing refresh...");
          sourceCorosSession = await getCorosSession(openid, true);
          sourceActs = await fetchCorosActivitiesUpTo(sourceCorosSession, fetchAll ? Infinity : syncLimit);
        } else {
          throw err;
        }
      }
      console.log(`COROS source: fetched ${sourceActs.length} activities`);
    } else {
      sourceActs = await fetchActivities(sourceClient, 0, syncLimit);
    }

    // 如果是 Garmin 目标，拉取目标平台最近活动来获取最新时间
    if (!targetIsCoros) {
      if (forceResync) {
        latestTargetActStartTime = "0";
        console.log("forceResync=true: will re-sync all activities to Garmin target");
      } else {
        const targetActs = await fetchActivities(targetClient, 0, 1);
        latestTargetActStartTime = targetActs[0]?.startTimeLocal ?? "0";
      }
    }

    result.total = sourceActs.length;
    const latestSourceActStartTime = sourceActs[0]?.startTimeLocal ?? "0";

    console.log(`Source activities: ${sourceActs.length}, target latest: ${latestTargetActStartTime}, source latest: ${latestSourceActStartTime}`);

    // 如果没有新活动（仅 Garmin 目标时可精确判断）
    if (!targetIsCoros && latestSourceActStartTime === latestTargetActStartTime) {
      const actName = sourceActs[0]?.activityName || "无";
      console.log(`没有要同步的活动内容, 最近的活动: 【${actName}】, 开始于: 【${latestSourceActStartTime}】`);
      return { success: true, message: `没有要同步的活动，最近活动: ${actName}`, data: result };
    }

    // 倒序同步（从最早的新活动开始）
    const reversedActs = [...sourceActs].reverse();
    let actualNewActivityCount = 1;

    for (let i = 0; i < reversedActs.length; i++) {
      const act = reversedActs[i];

      // 判断是否需要同步
      let shouldSync = false;
      if (targetIsCoros) {
        // COROS 目标：使用最后同步时间比较，或同步所有活动（如果没有最后同步时间）
        if (!latestTargetActStartTime || act.startTimeLocal > latestTargetActStartTime) {
          shouldSync = true;
        }
      } else {
        // Garmin 目标：与目标平台最新活动时间比较
        if (act.startTimeLocal > latestTargetActStartTime) {
          shouldSync = true;
        }
      }

      if (shouldSync) {
        const activityName = act.activityName || "未知活动";
        const activityId = String(act.activityId);

        try {
          // 创建同步记录
          const recordRes = await db.collection("syncRecords").add({
            data: {
              openid,
              direction,
              activityId,
              activityName,
              activityTime: act.startTimeLocal || "",
              status: "syncing",
              errorMsg: "",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });

          // 下载 FIT 文件
          console.log(`Downloading: ${activityId} - ${activityName}`);
          let fitFile;
          if (sourceIsCoros) {
            // 从 COROS 下载（需要 sportType 参数）
            const corosSportType = act.sportType || (act.corosRaw && act.corosRaw.sportType);
            fitFile = await downloadCorosFit(sourceCorosSession, activityId, corosSportType);
          } else {
            // 从 Garmin 下载
            try {
              fitFile = await downloadGarminActivity(sourceClient, act.activityId);
            } catch (dlErr) {
              if (shouldRefreshToken(dlErr)) {
                console.log(`Download ${dlErr.response?.status || 'error'}, refreshing source token and retrying...`);
                const newOauth2 = await refreshOauth2Token(sourceApi.oauth1, sourceApi.apiBase);
                const docId = (await db.collection("users").where({ openid }).get()).data[0]._id;
                await db.collection("users").doc(docId).update({ data: { [`${sourcePlatform}.oauth2`]: newOauth2 } });
                sourceClient.defaults.headers.common["Authorization"] = `Bearer ${newOauth2.access_token}`;
                fitFile = await downloadGarminActivity(sourceClient, act.activityId);
              } else {
                throw dlErr;
              }
            }
          }

          // 上传到目标平台
          console.log(`Uploading #${actualNewActivityCount}: 【${activityName}】, 开始于 【${act.startTimeLocal}】, 活动ID: 【${activityId}】`);
          if (targetIsCoros) {
            // 上传到 COROS
            let corosResult;
            try {
              corosResult = await uploadToCoros(fitFile.data, fitFile.path, corosSession);
              // 检查 COROS 导入结果（必须显式判断 success，不能只看 duplicate）
              if (corosResult.duplicate) {
                // COROS 已有该活动，跳过但不算失败
                await db.collection("syncRecords").doc(recordRes._id).update({
                  data: { status: "skipped", errorMsg: "COROS 已存在该活动", updatedAt: new Date() },
                });
                result.skipped++;
                console.log(`Skipped (duplicate in COROS): ${activityName}`);
                continue;
              }
              if (!corosResult.success) {
                // COROS 返回非成功（如 1019 token 失效），必须视为失败并抛出，触发刷新重试
                throw new Error(`COROS 导入失败: ${JSON.stringify(corosResult)}`);
              }
            } catch (ulErr) {
              // token 失效（如 1019 Access token is invalid）则刷新 session 重试一次
              const isTokenErr = ulErr.message && (ulErr.message.includes("Access token is invalid") || ulErr.message.includes("token"));
              if (isTokenErr) {
                try {
                  console.log(`COROS token invalid, refreshing session and retrying... error: ${ulErr.message}`);
                  corosSession = await getCorosSession(openid, true);
                  const retry = await uploadToCoros(fitFile.data, fitFile.path, corosSession);
                  if (retry.duplicate) {
                    await db.collection("syncRecords").doc(recordRes._id).update({
                      data: { status: "skipped", errorMsg: "COROS 已存在该活动", updatedAt: new Date() },
                    });
                    result.skipped++;
                    continue;
                  }
                  if (!retry.success) {
                    throw new Error(`COROS 导入重试失败: ${JSON.stringify(retry)}`);
                  }
                } catch (retryErr) {
                  throw retryErr; // 冒泡到外层 catch，标记该活动为失败
                }
              } else {
                throw ulErr;
              }
            }
          } else {
            // 上传到 Garmin
            try {
              await uploadGarminActivity(targetClient, fitFile.data, fitFile.path);
            } catch (ulErr) {
              if (shouldRefreshToken(ulErr)) {
                console.log(`Upload ${ulErr.response?.status || 'error'}, refreshing target token and retrying...`);
                const newOauth2 = await refreshOauth2Token(targetApi.oauth1, targetApi.apiBase);
                const docId = (await db.collection("users").where({ openid }).get()).data[0]._id;
                await db.collection("users").doc(docId).update({ data: { [`${targetPlatform}.oauth2`]: newOauth2 } });
                targetClient.defaults.headers.common["Authorization"] = `Bearer ${newOauth2.access_token}`;
                await uploadGarminActivity(targetClient, fitFile.data, fitFile.path);
              } else {
                throw ulErr;
              }
            }
          }

          // 更新同步记录为成功
          await db.collection("syncRecords").doc(recordRes._id).update({
            data: { status: "success", updatedAt: new Date() },
          });
          result.success++;
          actualNewActivityCount++;
          console.log(`Sync success: ${activityName}`);
        } catch (err) {
          // Garmin 返回 409 表示活动已存在（重复），记为跳过而非失败
          const isDuplicate409 = err.response?.status === 409 || (err.message && err.message.includes("status code 409"));
          if (isDuplicate409) {
            console.log(`活动 ${act.activityId} 已存在于目标平台，跳过`);
            try {
              const dupRecord = await db
                .collection("syncRecords")
                .where({ openid, activityId, direction, status: "syncing" })
                .get();
              if (dupRecord.data.length > 0) {
                await db.collection("syncRecords").doc(dupRecord.data[0]._id).update({
                  data: { status: "skipped", errorMsg: "活动已存在，跳过同步", updatedAt: new Date() },
                });
              }
            } catch (e) {
              console.error("更新跳过记录出错:", e);
            }
            result.skipped++;
          } else {
            console.error(`同步活动 ${act.activityId} 失败:`, err.message);
            try {
              const failRecord = await db
                .collection("syncRecords")
                .where({ openid, activityId, direction, status: "syncing" })
                .get();
              if (failRecord.data.length > 0) {
                await db.collection("syncRecords").doc(failRecord.data[0]._id).update({
                  data: { status: "failed", errorMsg: err.message, updatedAt: new Date() },
                });
              }
            } catch (e) {
              console.error("更新失败记录出错:", e);
            }
            result.failed++;
            result.errors.push({ activityId, activityName, error: err.message });
          }
        }

        await sleep(1000);
      } else {
        result.skipped++;
      }
    }

    // 更新用户最后同步时间
    const updateData = {
      lastSyncTime: new Date().toLocaleString("zh-CN"),
      updatedAt: new Date(),
    };

    // 为 COROS 方向额外保存最后同步的活动时间（用于下次增量判断）
    if (targetIsCoros && latestSourceActStartTime !== "0") {
      updateData[`lastSyncedActTime_${direction}`] = latestSourceActStartTime;
    }

    await db.collection("users").where({ openid }).update({ data: updateData });

    return { success: true, data: result };
  } catch (err) {
    console.error("syncActivities error:", err);
    return { success: false, message: err.message, data: result };
  }
}

/**
 * 获取活动列表
 */
async function getActivities(openid, event) {
  const { platform = "garminCn", start = 0, limit = 20 } = event;

  try {
    const platformApi = await getPlatformApi(openid, platform);
    const client = createApiClient(platformApi.apiBase, platformApi.oauth2);
    const activities = await fetchActivities(client, start, limit);
    return { success: true, data: activities };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * 获取活动详情
 */
async function getActivityDetail(openid, event) {
  const { activityId, platform = "garminCn" } = event;

  if (!activityId) {
    return { success: false, message: "缺少活动ID" };
  }

  try {
    const platformApi = await getPlatformApi(openid, platform);
    const client = createApiClient(platformApi.apiBase, platformApi.oauth2);
    const activity = await fetchActivity(client, activityId);
    return { success: true, data: activity };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * 延时函数
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== COROS 上传逻辑 ====================

// COROS 密码解密（与 garminAuth 中的加密配对，密钥相同）
const COROS_ENC_KEY = crypto.createHash("sha256").update("jjt-miniprogram-2024-enc").digest();

function decryptPassword(encrypted) {
  if (!encrypted || !encrypted.includes(":")) return encrypted; // 兼容旧明文数据
  const [ivHex, tagHex, encHex] = encrypted.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", COROS_ENC_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex")).toString("utf8") + decipher.final("utf8");
}

/**
 * 对密码进行 MD5 哈希
 */
function corosMd5Password(password) {
  return crypto.createHash("md5").update(password).digest("hex");
}

/**
 * 获取有效的 COROS session（过期则自动刷新）
 * 参照 garmin-sync-coros 项目，使用 teamcnapi 登录，按 regionId 路由到正确的 teamapi
 */
async function getCorosSession(openid, forceRefresh = false) {
  const userRes = await db.collection("users").where({ openid }).get();
  if (userRes.data.length === 0) {
    throw new Error("用户未登录");
  }

  const user = userRes.data[0];
  const corosData = user.coros;

  if (!corosData || !corosData.bound) {
    throw new Error("COROS 未绑定");
  }

  // 检查 session 是否过期、缺少 userId 或 regionId（旧绑定数据可能没有）
  const sessionExpired = corosData.expiresAt && Date.now() >= corosData.expiresAt;
  const userIdMissing = !corosData.userId;
  const regionIdMissing = !corosData.regionId;

  if (forceRefresh || sessionExpired || userIdMissing || regionIdMissing) {
    console.log(`COROS session refresh: expired=${sessionExpired}, userIdMissing=${userIdMissing}, regionIdMissing=${regionIdMissing}`);
    if (!corosData.email || !corosData.password) {
      throw new Error("COROS 登录凭证缺失，请重新绑定");
    }

    const hashedPwd = corosMd5Password(decryptPassword(corosData.password));
    const loginRes = await axios.post(
      `${COROS_LOGIN_API}/account/login`,
      { account: corosData.email, accountType: 2, pwd: hashedPwd },
      {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "Accept": "application/json, text/plain, */*",
        },
        validateStatus: (s) => s >= 200 && s < 500,
      }
    );

    const respData = loginRes.data || {};
    const loginData = respData.data || {};
    const isSuccess = respData.result === "0000" || respData.apiCode === "41C2B95C" || respData.code === 200;

    const accessToken = loginData.accessToken || respData.accessToken || "";
    const userId = loginData.userId || corosData.userId || "";
    const regionId = loginData.regionId || corosData.regionId || 2;
    const regionCfg = COROS_REGION_CONFIG[regionId] || COROS_REGION_CONFIG[2];

    if (loginRes.status !== 200 || !isSuccess || !accessToken) {
      throw new Error(`COROS session 刷新失败: HTTP ${loginRes.status}, success=${isSuccess}, token=${!!accessToken}`);
    }

    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    const docId = userRes.data[0]._id;
    await db.collection("users").doc(docId).update({
      data: {
        "coros.accessToken": accessToken,
        "coros.userId": userId,
        "coros.regionId": regionId,
        "coros.teamApi": regionCfg.teamapi,
        "coros.expiresAt": expiresAt,
        "coros.updatedAt": new Date(),
      },
    });

    console.log(`COROS session refreshed: userId=${userId}, regionId=${regionId}, teamApi=${regionCfg.teamapi}`);
    return { accessToken, userId, regionId, teamApi: regionCfg.teamapi };
  }

  return {
    accessToken: corosData.accessToken || "",
    userId: corosData.userId || "",
    regionId: corosData.regionId || 2,
    teamApi: corosData.teamApi || (COROS_REGION_CONFIG[corosData.regionId || 2] || COROS_REGION_CONFIG[2]).teamapi,
  };
}

/**
 * 上传 FIT 文件到 COROS（完整的 S3/OSS 上传流程）
 * 参照 garmin-sync-coros 开源项目实现：
 * 流程：获取 STS 凭证 → 打包 ZIP → 上传到 S3/OSS → 通知 COROS 导入
 */
async function uploadToCoros(fitData, filename, corosSession) {
  const fitBuffer = Buffer.from(fitData);
  const originalFilename = filename || "activity.fit";
  const regionId = corosSession.regionId || 2;
  const regionCfg = COROS_REGION_CONFIG[regionId] || COROS_REGION_CONFIG[2];
  const stsSign = COROS_STS_SIGN[regionId] || COROS_STS_SIGN[2];

  // 1. 获取 S3/STS 临时凭证（按区域使用不同的 bucket/service/sign）
  const stsRes = await axios.get(`${COROS_FAQ_API}/openapi/oss/sts`, {
    params: {
      bucket: regionCfg.bucket,
      service: regionCfg.service,
      v: 2,
      app_id: COROS_APP_ID,
      sign: stsSign,
    },
    validateStatus: (s) => s >= 200 && s < 500,
  });

  if (stsRes.status !== 200 || !stsRes.data || !stsRes.data.data || !stsRes.data.data.credentials) {
    throw new Error(`获取 COROS STS 凭证失败: HTTP ${stsRes.status}, regionId=${regionId}`);
  }

  // STS 凭证是 base64 + salt 编码的
  const rawCredentials = stsRes.data.data.credentials;
  const stripped = rawCredentials.replace(COROS_S3_SALT, "");
  const bucketData = JSON.parse(Buffer.from(stripped, "base64").toString());

  console.log(`COROS STS obtained: region=${regionId}, bucket=${regionCfg.bucket}, service=${regionCfg.service}`);

  // 2. 计算 FIT 文件 MD5，打包成 ZIP（coros-connect 要求 zip 内部路径为 {md5}/{filename}）
  const md5 = crypto.createHash("md5").update(fitBuffer).digest("hex");
  const zip = new JSZip();
  zip.file(`${md5}/${originalFilename}`, fitBuffer, { createFolders: true });
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  // S3 远程路径：fit_zip/{userId}/{md5}.zip（与 garmin-sync-coros 一致）
  const userId = corosSession.userId || "";
  if (!userId) {
    throw new Error("COROS userId 缺失，请重新绑定账号");
  }
  const remoteFilename = `fit_zip/${userId}/${md5}.zip`;

  // 3. 上传 ZIP 到 S3/OSS（使用区域对应的 endpoint）
  const s3Client = new S3Client({
    region: bucketData.Region || "us-east-1",
    endpoint: regionCfg.s3Endpoint,
    forcePathStyle: regionCfg.service === "aliyun", // 阿里云 OSS 需要 path-style
    credentials: {
      sessionToken: bucketData.SessionToken || bucketData.SecurityToken,
      accessKeyId: bucketData.AccessKeyId,
      secretAccessKey: bucketData.SecretAccessKey || bucketData.AccessKeySecret,
    },
  });

  await s3Client.send(new PutObjectCommand({
    Bucket: regionCfg.bucket,
    Key: remoteFilename,
    Body: zipBuffer,
    ContentType: "application/zip",
  }));

  console.log(`COROS S3 upload done: ${remoteFilename} (${zipBuffer.length} bytes)`);

  // 4. 通知 COROS 导入（使用区域对应的 teamapi）
  const teamApi = corosSession.teamApi || regionCfg.teamapi;
  const importBody = {
    source: 1,
    timezone: 32, // UTC+8 × 4 = 32（与 garmin-sync-coros 一致）
    bucket: regionCfg.bucket,
    md5: md5,
    size: zipBuffer.length,
    object: remoteFilename,
    serviceName: regionCfg.service,
    oriFileName: originalFilename,
  };

  const form = new FormData();
  form.append("jsonParameter", JSON.stringify(importBody));

  const importRes = await axios.post(
    `${teamApi}/activity/fit/import`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        "Accept": "application/json, text/plain, */*",
        "accesstoken": corosSession.accessToken,
      },
      timeout: 60000,
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );

  console.log("COROS import response:", JSON.stringify(importRes.data).substring(0, 500));

  // 解析导入结果
  const resData = importRes.data || {};
  const importData = resData.data || {};
  const isSuccess = resData.result === "0000" || resData.apiCode === "8E16FCC7";
  const hasError = importData.errorSize > 0;
  const isDuplicate = resData.message && resData.message.includes("exist");

  if (isDuplicate) {
    console.log("COROS import: activity already exists (duplicate, skipping)");
    return { success: false, duplicate: true };
  } else if (isSuccess && !hasError) {
    console.log("COROS import success");
    return { success: true, duplicate: false };
  } else if (isSuccess && hasError) {
    // finishSize + errorSize: 部分成功或有重复
    console.log(`COROS import: finishSize=${importData.finishSize}, errorSize=${importData.errorSize} (可能有重复)`);
    return { success: true, duplicate: false, hasError: true, errorSize: importData.errorSize };
  } else if (importRes.status !== 200) {
    throw new Error(`COROS 导入通知失败: HTTP ${importRes.status}`);
  } else {
    console.log("COROS import: non-success response:", resData.result, resData.message || "");
    return { success: false, duplicate: false };
  }
}

/**
 * 分页拉取 COROS 活动，直到拉够 limit 条或没有更多数据
 * COROS API 对 pageSize 参数校验严格，固定使用每页 20 条
 */
async function fetchCorosActivitiesUpTo(corosSession, limit) {
  const PAGE_SIZE = 20;
  const all = [];
  let pageNo = 1;
  // 安全上限 50 页（1000 条），避免死循环和云函数超时
  while (all.length < limit && pageNo <= 50) {
    const acts = await fetchCorosActivities(corosSession, pageNo, PAGE_SIZE);
    all.push(...acts);
    if (acts.length < PAGE_SIZE) break; // 没有更多数据了
    pageNo++;
  }
  return all.length > limit ? all.slice(0, limit) : all;
}

/**
 * 从 COROS 获取活动列表
 * 返回格式与 Garmin 活动列表对齐，便于统一处理
 */
async function fetchCorosActivities(corosSession, pageNo = 1, pageSize = 20) {
  const teamApi = corosSession.teamApi;
  // COROS API 参数名为 size 和 pageNumber（参照 garmin-sync-coros 开源项目）
  const res = await axios.get(`${teamApi}/activity/query`, {
    params: {
      size: pageSize,
      pageNumber: pageNo,
    },
    headers: {
      "Accept": "application/json, text/plain, */*",
      "accesstoken": corosSession.accessToken,
    },
    validateStatus: (s) => s >= 200 && s < 500,
  });

  if (res.status !== 200) {
    throw new Error(`COROS 活动列表请求失败: HTTP ${res.status}`);
  }

  const respData = res.data || {};
  const isSuccess = respData.result === "0000" || respData.apiCode === "B747D36D";
  if (!isSuccess) {
    throw new Error(`COROS 活动列表返回错误: ${respData.message || JSON.stringify(respData).substring(0, 200)}`);
  }

  const dataObj = respData.data || {};
  const dataList = dataObj.dataList || dataObj.data || [];

  // 转换为与 Garmin 活动列表兼容的格式
  return dataList.map((act) => ({
    activityId: String(act.labelId || act.activityId || act.id || ""),
    activityName: act.name || act.label || act.activityName || act.sportName || "未知活动",
    startTimeLocal: act.startTime ? formatCorosTime(act.startTime) : "",
    sportType: act.sportType,
    corosRaw: act, // 保留原始数据用于下载
  }));
}

/**
 * 格式化 COROS 时间为 ISO 格式（与 Garmin startTimeLocal 对齐）
 * COROS 返回格式可能是秒级时间戳、毫秒时间戳或 "2024-01-15 10:30:00" 字符串
 */
function formatCorosTime(timeStr) {
  if (!timeStr) return "";
  // 如果是数字（时间戳），转为日期字符串；秒级时间戳需要 x1000
  if (typeof timeStr === "number") {
    const ms = timeStr < 1e12 ? timeStr * 1000 : timeStr;
    const d = new Date(ms);
    return d.toISOString().replace("T", " ").substring(0, 19);
  }
  // 如果已经是字符串格式 "2024-01-15 10:30:00"，直接返回
  return String(timeStr).substring(0, 19);
}

/**
 * 从 COROS 下载活动的 FIT 文件
 * 参照 garmin-sync-coros 开源项目：POST /activity/detail/download（labelId + sportType + fileType=4）
 * 获取 data.fileUrl 后再 GET 下载实际文件
 */
async function downloadCorosFit(corosSession, activityId, sportType) {
  const teamApi = corosSession.teamApi;

  const dlRes = await axios.post(
    `${teamApi}/activity/detail/download`,
    null,
    {
      params: {
        labelId: activityId,
        sportType: sportType,
        fileType: 4, // 4 = FIT 格式
      },
      headers: {
        "Accept": "application/json, text/plain, */*",
        "accesstoken": corosSession.accessToken,
      },
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );

  if (dlRes.status !== 200) {
    throw new Error(`COROS FIT 下载请求失败: HTTP ${dlRes.status}`);
  }

  const respData = dlRes.data || {};

  // 从响应中提取下载 URL（开源项目中为 data.fileUrl）
  let downloadUrl = "";
  if (respData.data && typeof respData.data === "string") {
    downloadUrl = respData.data;
  } else if (respData.data && respData.data.fileUrl) {
    downloadUrl = respData.data.fileUrl;
  } else if (respData.data && respData.data.url) {
    downloadUrl = respData.data.url;
  }

  if (!downloadUrl) {
    throw new Error(`COROS FIT 下载失败: 无法获取下载链接, response=${JSON.stringify(respData).substring(0, 300)}`);
  }

  console.log(`COROS FIT download URL: ${downloadUrl.substring(0, 100)}`);

  // 下载实际文件
  const fileRes = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
  });

  const fileBuffer = Buffer.from(fileRes.data);
  console.log(`COROS FIT download: size=${fileBuffer.length} bytes`);

  // 检查是否是 zip 文件，如果是则解压
  if (fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4b) {
    const files = await decompress(fileBuffer);
    if (files && files.length > 0) {
      const fitFile = files.find((f) => f.path.endsWith(".fit")) || files[0];
      console.log(`COROS FIT extracted: ${fitFile.path}, size=${fitFile.data.length}`);
      return { path: fitFile.path, data: fitFile.data };
    }
  }

  return { path: `${activityId}.fit`, data: fileBuffer };
}
