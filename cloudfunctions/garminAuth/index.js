// 云函数 garminAuth - Garmin 认证（支持 MFA 二步验证）
const cloud = require("wx-server-sdk");
const axios = require("axios");
const qs = require("qs");
const crypto = require("crypto");
const OAuth = require("oauth-1.0a");

cloud.init({ env: "cloud1-d8gyv2pt7517e6c31" });
const db = cloud.database();

// OAuth consumer 地址（与 @gooin/garmin-connect 库相同）
const OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";

// CSRF / Ticket / AccountLocked 正则
const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TICKET_RE = /ticket=([^"&]+)/;
const LOCKED_RE = /var status\s*=\s*"([^"]*)"/;
const TITLE_RE = /<title>([^<]*)<\/title>/;
// MFA 页面特征：包含 mfa 相关的 form 或文字
const MFA_RE = /mfa|two[- ]?factor|verification\s*code|验证码/i;
// MFA 页面的 execution token（用于 MFA 第二步）
const MFA_EXEC_RE = /name="execution"\s+value="([^"]+)"/;

// ==================== 密码加密存储 ====================
// 使用 AES-256-GCM 加密，密钥固定存储在云函数中
const ENC_KEY = crypto.createHash("sha256").update("jjt-miniprogram-2024-enc").digest();

function encryptPassword(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 格式: iv:tag:ciphertext (全部 hex)
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + enc.toString("hex");
}

function decryptPassword(encrypted) {
  if (!encrypted || !encrypted.includes(":")) return encrypted; // 兼容旧明文数据
  const [ivHex, tagHex, encHex] = encrypted.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex")).toString("utf8") + decipher.final("utf8");
}

/**
 * 主入口
 */
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event;

  try {
    switch (action) {
      case "getBindInfo":
        return await getBindInfo(OPENID);
      case "bindWithPassword":
        return await bindWithPassword(OPENID, event);
      case "submitMfa":
        return await submitMfa(OPENID, event);
      case "autoRelogin":
        return await autoRelogin(OPENID, event);
      case "corosBind":
        return await corosBind(OPENID, event);
      case "corosRefresh":
        return await corosRefresh(OPENID, event);
      case "unbind":
        return await unbindPlatform(OPENID, event);
      default:
        return { success: false, message: "未知操作" };
    }
  } catch (err) {
    console.error("garminAuth error:", err);
    return { success: false, message: err.message || "服务器错误" };
  }
};

/**
 * 获取 OAuth consumer key/secret
 */
async function getOauthConsumer() {
  const res = await axios.get(OAUTH_CONSUMER_URL);
  return { key: res.data.consumer_key, secret: res.data.consumer_secret };
}

/**
 * 创建 OAuth 1.0a 签名客户端
 */
function createOAuthClient(consumer) {
  return new OAuth({
    consumer,
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });
}

/**
 * 佳明 SSO 基础 URL（根据库的 UrlClass 逻辑，国服用 sso.garmin.cn，国际服用 sso.garmin.com）
 */
function getSsoUrls(region) {
  const domain = region === "cn" ? "garmin.cn" : "garmin.com";
  const ssoOrigin = `https://sso.${domain}`;
  const gcModern = `https://connect.${domain}/modern`;
  const apiDomain = `https://connectapi.${domain}`;
  return {
    ssoOrigin,
    ssoEmbed: `${ssoOrigin}/sso/embed`,
    signinUrl: `${ssoOrigin}/sso/signin`,
    loginUrl: `${ssoOrigin}/sso/login`,
    gcModern,
    oauthUrl: `${apiDomain}/oauth-service/oauth`,
    apiBase: apiDomain,
  };
}

/**
 * 从 axios session 的请求历史中收集所有 set-cookie
 */
function collectSessionCookies(session) {
  const cookies = [];
  // axios 没有内置的 cookie jar，我们需要手动跟踪
  // 这里从 session 的 interceptors 收集
  if (session._collectedCookies) {
    cookies.push(...session._collectedCookies);
  }
  return cookies;
}

/**
 * 创建一个带 cookie 跟踪的 axios session
 */
function createTrackedSession() {
  const session = axios.create();
  session._collectedCookies = [];
  // 添加响应拦截器来收集 cookies
  session.interceptors.response.use((response) => {
    const setCookies = response.headers["set-cookie"] || [];
    setCookies.forEach((c) => {
      const nameValue = c.split(";")[0];
      // 去重
      const name = nameValue.split("=")[0];
      const idx = session._collectedCookies.findIndex((existing) => existing.startsWith(name + "="));
      if (idx >= 0) {
        session._collectedCookies[idx] = nameValue;
      } else {
        session._collectedCookies.push(nameValue);
      }
    });
    // 自动在后续请求中带上 cookies
    if (session._collectedCookies.length > 0) {
      session.defaults.headers.common["Cookie"] = session._collectedCookies.join("; ");
    }
    return response;
  });
  return session;
}

/**
 * 第一步：提交账号密码，返回 ticket 或 MFA 挑战
 * 完全参照 @gooin/garmin-connect 库 HttpClient.ts 的 getLoginTicket 方法
 */
async function loginStep1(username, password, region) {
  const urls = getSsoUrls(region);
  const session = createTrackedSession();

  // Step 1: 设置 cookies（与库的 step1 完全一致）
  const step1Params = {
    clientId: "GarminConnect",
    locale: "en",
    service: urls.gcModern,
  };
  const step1Url = `${urls.ssoEmbed}?${qs.stringify(step1Params)}`;
  await session.get(step1Url);

  // Step 2: 获取 _csrf（与库的 step2 完全一致）
  const step2Params = {
    id: "gauth-widget",
    embedWidget: "true",
    locale: "en",
    gauthHost: urls.ssoEmbed,
  };
  const step2Url = `${urls.signinUrl}?${qs.stringify(step2Params)}`;
  const step2Result = await session.get(step2Url);
  const pageHtml = typeof step2Result.data === "string" ? step2Result.data : "";

  const csrfMatch = CSRF_RE.exec(pageHtml);
  if (!csrfMatch) {
    console.error("loginStep1: CSRF not found. Page snippet:", pageHtml.substring(0, 800));
    throw new Error("CSRF token not found");
  }
  const csrfToken = csrfMatch[1];

  // Step 3: 提交登录（与库的 step3 完全一致，只发 username/password/embed/_csrf）
  const signinParams = {
    id: "gauth-widget",
    embedWidget: "true",
    clientId: "GarminConnect",
    locale: "en",
    gauthHost: urls.ssoEmbed,
    service: urls.ssoEmbed,
    source: urls.ssoEmbed,
    redirectAfterAccountLoginUrl: urls.ssoEmbed,
    redirectAfterAccountCreationUrl: urls.ssoEmbed,
  };
  const step3Url = `${urls.signinUrl}?${qs.stringify(signinParams)}`;

  // 使用 urlencoded 格式（与库的 Content-Type 设置一致）
  const loginData = {
    username,
    password,
    embed: "true",
    _csrf: csrfToken,
  };

  console.log("loginStep1: posting to signin, csrf =", csrfToken.substring(0, 8) + "...");

  const step3Res = await session.post(step3Url, qs.stringify(loginData), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Dnt: 1,
      Origin: urls.ssoOrigin,
      Referer: urls.signinUrl,
      "User-Agent": USER_AGENT,
    },
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 500,
  });

  const html = typeof step3Res.data === "string" ? step3Res.data : "";
  const location = step3Res.headers["location"] || "";
  console.log("loginStep1: response status =", step3Res.status, "html length =", html.length, "location:", location.substring(0, 200));

  // 302 重定向：登录成功，ticket 在 Location 头中
  if (step3Res.status === 302 || step3Res.status === 301) {
    if (location.includes("ticket=")) {
      const url = new URL(location, urls.ssoOrigin);
      const ticket = url.searchParams.get("ticket");
      console.log("loginStep1: ticket found in redirect location");
      return { ticket, urls, session };
    }
    // 重定向但没有 ticket，可能是 MFA 重定向，跟随重定向查看目标页面
    if (location) {
      console.log("loginStep1: redirect without ticket, following redirect...");
      const redirectUrl = location.startsWith("http") ? location : `${urls.ssoOrigin}${location}`;

      // 先检查重定向 URL 是否包含 MFA 关键字
      if (/mfa|verifyMFA|enterMfaCode/i.test(redirectUrl)) {
        console.log("loginStep1: MFA detected from redirect URL");
        // 获取 MFA 页面以提取 execution token
        const mfaPageRes = await session.get(redirectUrl, {
          maxRedirects: 5,
          validateStatus: (s) => s >= 200 && s < 500,
        });
        const mfaHtml = typeof mfaPageRes.data === "string" ? mfaPageRes.data : "";
        console.log("loginStep1: MFA page loaded, length =", mfaHtml.length);

        // 提取 execution token（尝试多种正则）
        let mfaExecution = "";
        const execPatterns = [
          /name="execution"\s+value="([^"]+)"/,
          /name=['"]execution['"]\s+value=['"]([^'"]+)['"]/,
          /value="([^"]+)"\s+name="execution"/,
          /id="execution"\s+value="([^"]+)"/,
          /execution['":\s]+['"]([^'"]{20,})['"]/,
        ];
        for (const pat of execPatterns) {
          const m = pat.exec(mfaHtml);
          if (m) { mfaExecution = m[1]; break; }
        }
        console.log("MFA required, execution:", mfaExecution ? "found" : "not found");
        if (!mfaExecution) {
          // 输出 MFA 页面片段用于调试
          console.log("loginStep1: MFA page snippet:", mfaHtml.substring(0, 800));
        }

        // 提取 MFA 表单的 form action URL
        const formActionMatch = /<form[^>]+action="([^"]+)"/i.exec(mfaHtml);
        const mfaFormAction = formActionMatch ? formActionMatch[1] : "";
        console.log("loginStep1: MFA form action:", mfaFormAction || "(not found, will use redirectUrl)");

        // 收集所有 session cookies（从所有步骤的 set-cookie 头）
        const allCookies = collectSessionCookies(session);
        // 加上 MFA 页面新设置的 cookies
        const mfaSetCookies = mfaPageRes.headers["set-cookie"] || [];
        mfaSetCookies.forEach((c) => {
          allCookies.push(c.split(";")[0]);
        });
        const cookieStr = allCookies.join("; ");
        console.log("loginStep1: collected cookies count:", allCookies.length);

        return { mfaRequired: true, execution: mfaExecution, cookieStr, urls, mfaEndpoint: redirectUrl };
      }

      const redirectRes = await session.get(redirectUrl, {
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 500,
      });
      const redirectHtml = typeof redirectRes.data === "string" ? redirectRes.data : "";
      console.log("loginStep1: redirect response status =", redirectRes.status, "html length =", redirectHtml.length);

      // 检查重定向后的页面是否包含 ticket
      const redirectTicketMatch = TICKET_RE.exec(redirectHtml);
      if (redirectTicketMatch) {
        return { ticket: redirectTicketMatch[1], urls, session };
      }
      // 检查重定向后的 Location
      const redirectLocation = redirectRes.headers["location"] || "";
      if (redirectLocation.includes("ticket=")) {
        const url = new URL(redirectLocation, urls.ssoOrigin);
        return { ticket: url.searchParams.get("ticket"), urls, session };
      }
      // 检查是否是 MFA 页面（通过 HTML 内容或重定向 URL）
      if ((MFA_RE.test(redirectHtml) || /mfa|verifyMFA/i.test(redirectUrl)) && !TICKET_RE.test(redirectHtml)) {
        const mfaExecMatch = MFA_EXEC_RE.exec(redirectHtml);
        const mfaExecution = mfaExecMatch ? mfaExecMatch[1] : "";
        console.log("MFA required after redirect, execution:", mfaExecution ? "found" : "not found");
        const formActionMatch = /<form[^>]+action="([^"]+)"/i.exec(redirectHtml);
        const mfaFormAction = formActionMatch ? formActionMatch[1] : "";
        const mfaEndpoint = mfaFormAction
          ? (mfaFormAction.startsWith("http") ? mfaFormAction : `${urls.ssoOrigin}${mfaFormAction}`)
          : redirectUrl;
        const allCookies = collectSessionCookies(session);
        const setCookies = redirectRes.headers["set-cookie"] || [];
        setCookies.forEach((c) => allCookies.push(c.split(";")[0]));
        const cookieStr = allCookies.join("; ");
        return { mfaRequired: true, execution: mfaExecution, cookieStr, urls, mfaEndpoint };
      }
      console.error("loginStep1: redirect page has no ticket. url:", redirectUrl.substring(0, 200), "html snippet:", redirectHtml.substring(0, 500));
    }
    throw new Error("Login failed: Redirect without ticket");
  }

  // 先检查 401 认证失败（优先级最高）
  if (step3Res.status === 401) {
    // 提取页面中的错误信息
    const errorMsgMatch = /class="error"[^>]*>([^<]+)</.exec(html);
    const errorText = errorMsgMatch ? errorMsgMatch[1].trim() : "";
    console.error("loginStep1: 401, error text:", errorText, "html snippet:", html.substring(0, 1000));
    throw new Error(errorText || "账号或密码错误 (401 Unauthorized)");
  }

  // 检查账号锁定（只有明确包含 Locked/locked 才算锁定）
  const lockedMatch = LOCKED_RE.exec(html);
  if (lockedMatch && /lock/i.test(lockedMatch[1])) {
    throw new Error(`AccountLocked: ${lockedMatch[1]}`);
  }

  // 检查通用登录失败状态
  const statusMatch = LOCKED_RE.exec(html);
  if (statusMatch && statusMatch[1] === "FAIL") {
    // 提取具体错误信息
    const errDetail = /var errorMessage\s*=\s*"([^"]*)"/.exec(html);
    const errText = errDetail ? errDetail[1] : "";
    const displayErr = /<span[^>]*class="error[^"]*"[^>]*>([^<]+)</.exec(html);
    const displayText = displayErr ? displayErr[1].trim() : "";
    console.error("loginStep1: status=FAIL, error:", errText || displayText, "html snippet:", html.substring(0, 1000));
    throw new Error(errText || displayText || "登录失败，请检查账号密码");
  }

  // 检查页面标题
  const titleMatch = TITLE_RE.exec(html);
  if (titleMatch && titleMatch[1].includes("Update Phone Number")) {
    throw new Error("需要更新手机号码，请在网页端更新");
  }

  // 检查是否需要 MFA
  if (MFA_RE.test(html) && !TICKET_RE.test(html)) {
    const mfaExecMatch = MFA_EXEC_RE.exec(html);
    const mfaExecution = mfaExecMatch ? mfaExecMatch[1] : "";
    console.log("MFA required (from HTML), execution:", mfaExecution ? "found" : "not found");

    // 提取 MFA 表单 action
    const formActionMatch = /<form[^>]+action="([^"]+)"/i.exec(html);
    const mfaFormAction = formActionMatch ? formActionMatch[1] : "";
    const mfaEndpoint = mfaFormAction
      ? (mfaFormAction.startsWith("http") ? mfaFormAction : `${urls.ssoOrigin}${mfaFormAction}`)
      : `${urls.ssoOrigin}/sso/verifyMFA/loginEnterMfaCode`;

    const allCookies = collectSessionCookies(session);
    const setCookies = step3Res.headers["set-cookie"] || [];
    setCookies.forEach((c) => allCookies.push(c.split(";")[0]));
    const cookieStr = allCookies.join("; ");

    return {
      mfaRequired: true,
      execution: mfaExecution,
      cookieStr,
      urls,
      mfaEndpoint,
    };
  }

  // 尝试提取 ticket
  const ticketMatch = TICKET_RE.exec(html);
  if (ticketMatch) {
    return { ticket: ticketMatch[1], urls, session };
  }

  // 检查重定向中的 ticket（非 302 响应也可能有 Location 头）
  const locationHeader = step3Res.headers["location"] || "";
  if (locationHeader.includes("ticket=")) {
    const url = new URL(locationHeader, urls.ssoOrigin);
    return { ticket: url.searchParams.get("ticket"), urls, session };
  }

  console.error("loginStep1: no ticket found. status:", step3Res.status, "location:", locationHeader.substring(0, 200), "html snippet:", html.substring(0, 500));
  throw new Error("Login failed: No ticket found (wrong password or MFA)");
}

/**
 * 第二步：提交 MFA 验证码，获取 ticket
 */
async function loginStep2Mfa(execution, mfaCode, cookieStr, urls, mfaEndpoint) {
  const session = createTrackedSession();
  if (cookieStr) {
    session.defaults.headers.common["Cookie"] = cookieStr;
    session._collectedCookies = cookieStr.split("; ").filter(Boolean);
  }

  // MFA 提交 URL：优先使用保存的 MFA 端点，否则用默认的 verifyMFA 路径
  const mfaSubmitUrl = mfaEndpoint || `${urls.ssoOrigin}/sso/verifyMFA/loginEnterMfaCode`;

  const formData = {
    "mfa-code": mfaCode,
    embed: "true",
    _eventId: "submit",
  };
  if (execution) {
    formData.execution = execution;
  }

  console.log("loginStep2Mfa: posting to", mfaSubmitUrl.substring(0, 100), "code length:", mfaCode.length);

  // MFA 表单提交参数（与 signin 不同的 query params）
  const mfaQueryParams = {
    id: "gauth-widget",
    embedWidget: "true",
    clientId: "GarminConnect",
    locale: "en",
    gauthHost: urls.ssoEmbed,
    service: urls.gcModern,
  };

  const res = await session.post(
    `${mfaSubmitUrl}?${qs.stringify(mfaQueryParams)}`,
    qs.stringify(formData),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Dnt: 1,
        Origin: urls.ssoOrigin,
        Referer: mfaSubmitUrl,
        "User-Agent": USER_AGENT,
      },
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );

  const html = typeof res.data === "string" ? res.data : "";
  const location = res.headers["location"] || "";
  console.log("loginStep2Mfa: response status =", res.status, "html length =", html.length, "location:", location.substring(0, 200));

  // 检查 HTML 中的 ticket
  const ticketMatch = TICKET_RE.exec(html);
  if (ticketMatch) {
    console.log("loginStep2Mfa: ticket found in HTML");
    return { ticket: ticketMatch[1], session };
  }

  // 检查 302 重定向中的 ticket
  if (location.includes("ticket=")) {
    const url = new URL(location, urls.ssoOrigin);
    console.log("loginStep2Mfa: ticket found in redirect location");
    return { ticket: url.searchParams.get("ticket"), session };
  }

  // 302 重定向但没有直接 ticket，跟随重定向
  if ((res.status === 302 || res.status === 301) && location) {
    console.log("loginStep2Mfa: following redirect after MFA...");
    const redirectUrl = location.startsWith("http") ? location : `${urls.ssoOrigin}${location}`;
    const redirectRes = await session.get(redirectUrl, {
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    const redirectHtml = typeof redirectRes.data === "string" ? redirectRes.data : "";
    const redirectTicket = TICKET_RE.exec(redirectHtml);
    if (redirectTicket) {
      console.log("loginStep2Mfa: ticket found after following redirect");
      return { ticket: redirectTicket[1], session };
    }
    const redirectLocation = redirectRes.headers["location"] || "";
    if (redirectLocation.includes("ticket=")) {
      const url = new URL(redirectLocation, urls.ssoOrigin);
      console.log("loginStep2Mfa: ticket found in nested redirect");
      return { ticket: url.searchParams.get("ticket"), session };
    }
    console.error("loginStep2Mfa: redirect has no ticket. html snippet:", redirectHtml.substring(0, 500));
  }

  // 检查是否仍然需要 MFA（验证码错误）
  if (MFA_RE.test(html)) {
    throw new Error("MFA code incorrect or expired");
  }

  console.error("loginStep2Mfa: no ticket found. html snippet:", html.substring(0, 500));
  throw new Error("MFA verification failed: No ticket found");
}

/**
 * 用 ticket 换取 OAuth1 token
 */
async function getOauth1Token(ticket, urls) {
  const consumer = await getOauthConsumer();
  const oauth = createOAuthClient(consumer);

  const params = {
    ticket,
    "login-url": urls.ssoEmbed,
    "accepts-mfa-tokens": true,
  };
  const url = `${urls.oauthUrl}/preauthorized?${qs.stringify(params)}`;

  const requestData = { url, method: "GET" };
  const headers = oauth.toHeader(oauth.authorize(requestData));

  const res = await axios.get(url, {
    headers: { ...headers, "User-Agent": "com.garmin.android.apps.connectmobile" },
  });

  const token = qs.parse(res.data);
  return { token, oauth, consumer, urls };
}

/**
 * 用 OAuth1 换取 OAuth2 token
 */
async function exchangeOauth2(oauth1Data) {
  const { token, oauth, consumer } = oauth1Data;
  const oauthToken = { key: token.oauth_token, secret: token.oauth_token_secret };

  const baseUrl = `${oauth1Data.urls.oauthUrl}/exchange/user/2.0`;
  const requestData = { url: baseUrl, method: "POST", data: null };
  const authData = oauth.authorize(requestData, oauthToken);
  const url = `${baseUrl}?${qs.stringify(authData)}`;

  const res = await axios.post(url, null, {
    headers: {
      "User-Agent": "com.garmin.android.apps.connectmobile",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const oauth2 = res.data;
  oauth2.expires_at = Math.floor(Date.now() / 1000) + oauth2.expires_in;
  return { oauth1: token, oauth2 };
}

/**
 * 获取用户信息
 */
async function getUserProfile(oauth1, oauth2, urls) {
  const consumer = await getOauthConsumer();
  const oauth = createOAuthClient(consumer);
  const oauthToken = { key: oauth1.oauth_token, secret: oauth1.oauth_token_secret };

  const profileUrl = `${urls.apiBase}/userprofile-service/socialProfile`;
  const requestData = { url: profileUrl, method: "GET" };
  const headers = oauth.toHeader(oauth.authorize(requestData, oauthToken));

  const res = await axios.get(profileUrl, {
    headers: {
      ...headers,
      Authorization: `Bearer ${oauth2.access_token}`,
      "User-Agent": USER_AGENT,
    },
  });

  return res.data;
}

// ==================== Action 处理函数 ====================

async function getBindInfo(openid) {
  try {
    const userRes = await db.collection("users").where({ openid }).get();
    if (userRes.data.length > 0) {
      const user = userRes.data[0];
      return {
        success: true,
        data: {
          garminCn: { bound: !!user.garminCn?.bound, displayName: user.garminCn?.displayName || "" },
          garminCom: { bound: !!user.garminCom?.bound, displayName: user.garminCom?.displayName || "" },
          coros: { bound: !!user.coros?.bound, displayName: user.coros?.displayName || "" },
          lastSyncTime: user.lastSyncTime || "",
        },
      };
    }
    return {
      success: true,
      data: {
        garminCn: { bound: false, displayName: "" },
        garminCom: { bound: false, displayName: "" },
        coros: { bound: false, displayName: "" },
        lastSyncTime: "",
      },
    };
  } catch (err) {
    console.error("getBindInfo error:", err);
    return { success: false, message: "获取绑定信息失败" };
  }
}

async function bindWithPassword(openid, event) {
  const { platform, username, password } = event;
  if (!platform || !username || !password) {
    return { success: false, message: "参数不完整" };
  }

  const region = platform === "garminCn" ? "cn" : "com";

  try {
    const step1Result = await loginStep1(username, password, region);

    // 需要 MFA 验证
    if (step1Result.mfaRequired) {
      // 保存中间状态到数据库
      await saveMfaState(openid, platform, {
        username,
        password,
        region,
        execution: step1Result.execution,
        cookieStr: step1Result.cookieStr,
        urls: step1Result.urls,
        mfaEndpoint: step1Result.mfaEndpoint,
      });
      return {
        success: true,
        mfaRequired: true,
        message: "需要输入短信验证码",
      };
    }

    // 直接获取到 ticket，完成 OAuth 流程
    const oauth1Data = await getOauth1Token(step1Result.ticket, step1Result.urls);
    const tokens = await exchangeOauth2(oauth1Data);
    const userInfo = await getUserProfile(tokens.oauth1, tokens.oauth2, step1Result.urls);

    const displayName = userInfo.fullName || userInfo.userName || username;
    await saveBindResult(openid, platform, {
      oauth1: tokens.oauth1,
      oauth2: tokens.oauth2,
      displayName,
      username,
      password,  // 保存密码用于 token 失效时自动重登
    });

    return { success: true, message: "绑定成功", data: { displayName } };
  } catch (err) {
    console.error("bindWithPassword error:", err);
    return handleLoginError(err);
  }
}

/**
 * 提交 MFA 验证码
 */
async function submitMfa(openid, event) {
  const { platform, mfaCode } = event;
  if (!mfaCode) {
    return { success: false, message: "请输入验证码" };
  }

  try {
    // 读取保存的 MFA 中间状态
    const state = await getMfaState(openid, platform);
    if (!state) {
      return { success: false, message: "登录会话已过期，请重新输入账号密码" };
    }

    // 提交 MFA 验证码
    const step2Result = await loginStep2Mfa(state.execution, mfaCode, state.cookieStr, state.urls, state.mfaEndpoint);

    // 完成 OAuth 流程
    const oauth1Data = await getOauth1Token(step2Result.ticket, state.urls);
    const tokens = await exchangeOauth2(oauth1Data);
    const userInfo = await getUserProfile(tokens.oauth1, tokens.oauth2, state.urls);

    const displayName = userInfo.fullName || userInfo.userName || state.username;
    await saveBindResult(openid, platform, {
      oauth1: tokens.oauth1,
      oauth2: tokens.oauth2,
      displayName,
      username: state.username,
      password: state.password,  // 保存密码用于 token 失效时自动重登
    });

    // 清除 MFA 中间状态
    await clearMfaState(openid, platform);

    return { success: true, message: "绑定成功", data: { displayName } };
  } catch (err) {
    console.error("submitMfa error:", err);
    if (err.message && err.message.includes("MFA code")) {
      return { success: false, message: "验证码错误或已过期，请重新获取" };
    }
    return handleLoginError(err);
  }
}

async function unbindPlatform(openid, event) {
  const { platform } = event;
  try {
    const updateData = {
      [`${platform}`]: { bound: false, oauth1: null, oauth2: null, displayName: "", username: "" },
      [`${platform}_mfaState`]: db.command.remove(),
      updatedAt: new Date(),
    };
    await db.collection("users").where({ openid }).update({
      data: updateData,
    });
    return { success: true, message: "解绑成功" };
  } catch (err) {
    console.error("unbind error:", err);
    return { success: false, message: "解绑失败" };
  }
}

// ==================== 数据库辅助函数 ====================

async function saveBindResult(openid, platform, data) {
  // 只保存必要的 token 字段，过滤掉可能导致数据库冲突的额外字段
  const oauth1Clean = {
    oauth_token: data.oauth1.oauth_token,
    oauth_token_secret: data.oauth1.oauth_token_secret,
  };
  const oauth2Clean = {
    access_token: data.oauth2.access_token,
    refresh_token: data.oauth2.refresh_token,
    token_type: data.oauth2.token_type,
    expires_in: data.oauth2.expires_in,
    expires_at: data.oauth2.expires_at,
  };

  const platformUpdate = {
    bound: true,
    oauth1: oauth1Clean,
    oauth2: oauth2Clean,
    displayName: data.displayName,
    username: data.username,
    // 保存加密后的登录凭据用于 token 失效时自动重新登录（仅限 Garmin 平台）
    ...(data.password ? { password: encryptPassword(data.password) } : {}),
    updatedAt: new Date(),
  };

  const userRes = await db.collection("users").where({ openid }).get();
  if (userRes.data.length > 0) {
    // 先删除旧的平台数据（避免 null 字段上创建嵌套字段的冲突），再重新设置
    const docId = userRes.data[0]._id;
    await db.collection("users").doc(docId).update({
      data: { [`${platform}`]: db.command.remove(), updatedAt: new Date() },
    });
    await db.collection("users").doc(docId).update({
      data: { [platform]: platformUpdate, updatedAt: new Date() },
    });
  } else {
    await db.collection("users").add({
      data: {
        openid,
        garminCn: { bound: false, oauth1: null, oauth2: null, displayName: "", username: "" },
        garminCom: { bound: false, oauth1: null, oauth2: null, displayName: "", username: "" },
        coros: { bound: false, oauth1: null, oauth2: null, displayName: "", username: "" },
        lastSyncTime: "",
        createdAt: new Date(),
        [platform]: platformUpdate,
        updatedAt: new Date(),
      },
    });
  }
}

async function saveMfaState(openid, platform, state) {
  const userRes = await db.collection("users").where({ openid }).get();
  const mfaState = {
    username: state.username,
    password: state.password ? encryptPassword(state.password) : "",
    region: state.region,
    execution: state.execution || "",
    cookieStr: state.cookieStr || "",
    urls: state.urls || {},
    mfaEndpoint: state.mfaEndpoint || "",
    createdAt: Date.now(),
  };

  if (userRes.data.length > 0) {
    const docId = userRes.data[0]._id;
    try {
      // 先尝试直接更新
      await db.collection("users").doc(docId).update({
        data: { [`${platform}_mfaState`]: mfaState },
      });
    } catch (e) {
      // 如果失败（例如 null 字段导致嵌套更新错误），先删除旧字段再重新写入
      console.log(`saveMfaState: first attempt failed (${e.errMsg || e.message}), retrying with remove+add...`);
      try {
        await db.collection("users").doc(docId).update({
          data: { [`${platform}_mfaState`]: db.command.remove() },
        });
      } catch (_) { /* 忽略，字段可能已不存在 */ }
      await db.collection("users").doc(docId).update({
        data: { [`${platform}_mfaState`]: mfaState },
      });
    }
  } else {
    await db.collection("users").add({
      data: {
        openid,
        garminCn: { bound: false, oauth1: null, oauth2: null, displayName: "", username: "" },
        garminCom: { bound: false, oauth1: null, oauth2: null, displayName: "", username: "" },
        coros: { bound: false, oauth1: null, oauth2: null, displayName: "", username: "" },
        [`${platform}_mfaState`]: mfaState,
        createdAt: new Date(),
      },
    });
  }
}

async function getMfaState(openid, platform) {
  const userRes = await db.collection("users").where({ openid }).get();
  if (userRes.data.length === 0) return null;
  const state = userRes.data[0][`${platform}_mfaState`];
  if (!state) return null;
  // 5 分钟过期
  if (Date.now() - state.createdAt > 5 * 60 * 1000) return null;
  // 解密密码
  if (state.password) {
    state.password = decryptPassword(state.password);
  }
  return state;
}

async function clearMfaState(openid, platform) {
  try {
    await db.collection("users").where({ openid }).update({
      data: { [`${platform}_mfaState`]: null },
    });
  } catch (e) {
    // ignore
  }
}

/**
 * 自动重新登录（token 失效时使用保存的账号密码）
 * 返回:
 *   - success: true → 自动登录成功，新 token 已保存
 *   - mfaRequired: true → 需要 MFA 验证码，mfaState 已保存
 *   - success: false → 登录失败（密码错误等）
 */
async function autoRelogin(openid, event) {
  const { platform } = event;
  if (!platform || !platform.startsWith("garmin")) {
    return { success: false, message: "仅支持 Garmin 平台" };
  }

  const userRes = await db.collection("users").where({ openid }).get();
  if (userRes.data.length === 0) {
    return { success: false, message: "用户未绑定" };
  }

  const platformData = userRes.data[0][platform];
  if (!platformData || !platformData.bound || !platformData.username || !platformData.password) {
    return { success: false, message: "登录凭据缺失，请手动重新绑定" };
  }

  const { username } = platformData;
  const password = decryptPassword(platformData.password);
  const region = platform === "garminCn" ? "cn" : "com";
  console.log(`autoRelogin: ${platform} user=${username}`);

  try {
    const step1Result = await loginStep1(username, password, region);

    // 需要 MFA
    if (step1Result.mfaRequired) {
      await saveMfaState(openid, platform, {
        username,
        password,
        region,
        execution: step1Result.execution,
        cookieStr: step1Result.cookieStr,
        urls: step1Result.urls,
        mfaEndpoint: step1Result.mfaEndpoint,
      });
      console.log("autoRelogin: MFA required, state saved");
      return { success: false, mfaRequired: true, message: "需要输入验证码" };
    }

    // 直接登录成功（无 MFA）
    const oauth1Data = await getOauth1Token(step1Result.ticket, step1Result.urls);
    const tokens = await exchangeOauth2(oauth1Data);
    const userInfo = await getUserProfile(tokens.oauth1, tokens.oauth2, step1Result.urls);

    const displayName = userInfo.fullName || userInfo.userName || username;
    await saveBindResult(openid, platform, {
      oauth1: tokens.oauth1,
      oauth2: tokens.oauth2,
      displayName,
      username,
      password,
    });

    console.log(`autoRelogin: ${platform} login success, user=${displayName}`);
    return { success: true, message: "自动重新登录成功", data: { displayName } };
  } catch (err) {
    console.error("autoRelogin error:", err);
    return { success: false, message: `自动重新登录失败: ${err.message}` };
  }
}

// ==================== COROS 认证 ====================

// COROS 登录端点（所有区域统一使用 CN 登录入口，登录后由 regionId 路由到正确的 API）
const COROS_LOGIN_API = "https://teamcnapi.coros.com";

// COROS 区域 → teamapi 映射
const COROS_REGION_API = {
  1: "https://teamapi.coros.com",     // 美区
  2: "https://teamcnapi.coros.com",   // 中国区
  3: "https://teameuapi.coros.com",   // 欧区
};

/**
 * 对密码进行 MD5 哈希（COROS Web API 要求 MD5 哈希密码）
 */
function corosMd5Password(password) {
  return crypto.createHash("md5").update(password).digest("hex");
}

/**
 * COROS 登录：用邮箱+密码换取 access token、userId、regionId
 * 参照 garmin-sync-coros 开源项目，使用 teamcnapi 登录入口
 */
async function corosLogin(email, password) {
  const hashedPwd = corosMd5Password(password);

  const loginPayload = {
    account: email,
    accountType: 2, // 2 = email
    pwd: hashedPwd,
  };

  const loginRes = await axios.post(
    `${COROS_LOGIN_API}/account/login`,
    loginPayload,
    {
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.39 Safari/537.36",
      },
      validateStatus: (s) => s >= 200 && s < 500,
    }
  );

  console.log("corosLogin: status =", loginRes.status);
  console.log("corosLogin: response data:", JSON.stringify(loginRes.data).substring(0, 800));

  if (loginRes.status !== 200) {
    if (loginRes.status === 401 || loginRes.status === 403) {
      throw new Error("COROS 账号或密码错误");
    }
    throw new Error(`COROS 登录失败: HTTP ${loginRes.status}`);
  }

  const data = loginRes.data;

  // 判断登录是否成功
  // garmin-sync-coros: result === "0000" 表示成功
  // 兼容其他格式: apiCode === "41C2B95C", code === 200
  const isSuccess =
    data.result === "0000" ||
    data.apiCode === "41C2B95C" ||
    data.code === 200;

  if (!isSuccess) {
    const errMsg = data.message || data.msg || JSON.stringify(data).substring(0, 200);
    throw new Error(`COROS 登录失败: ${errMsg}`);
  }

  // 从 data.data 中提取关键字段
  const loginData = data.data || {};
  const accessToken = loginData.accessToken || data.accessToken || "";
  const userId = loginData.userId || data.userId || "";
  const regionId = loginData.regionId || data.regionId || 2; // 默认中国区

  if (!accessToken) {
    console.error("corosLogin: accessToken not found.");
    console.error("Body keys:", Object.keys(data).join(", "));
    if (loginData) console.error("data.data keys:", Object.keys(loginData).join(", "));
    throw new Error("COROS 登录成功但未找到 access token");
  }

  console.log(`corosLogin: success, userId=${userId}, regionId=${regionId}, tokenLen=${accessToken.length}`);

  const displayName = loginData.nickName || loginData.name || loginData.userName || email;
  const teamApi = COROS_REGION_API[regionId] || COROS_REGION_API[2];

  // session 有效期约 24 小时
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

  return {
    accessToken,
    userId,
    regionId,
    teamApi,
    displayName,
    expiresAt,
  };
}

/**
 * COROS 绑定 action 处理
 */
async function corosBind(openid, event) {
  const { email, password } = event;
  if (!email || !password) {
    return { success: false, message: "请输入邮箱和密码" };
  }

  try {
    const loginResult = await corosLogin(email.trim(), password);

    // 保存到数据库
    await saveCorosBindResult(openid, {
      accessToken: loginResult.accessToken,
      userId: loginResult.userId,
      regionId: loginResult.regionId,
      teamApi: loginResult.teamApi,
      displayName: loginResult.displayName,
      email: email.trim(),
      password: password,
      expiresAt: loginResult.expiresAt,
    });

    return {
      success: true,
      message: "COROS 绑定成功",
      data: { displayName: loginResult.displayName },
    };
  } catch (err) {
    console.error("corosBind error:", err);
    if (err.message.includes("密码") || err.message.includes("账号")) {
      return { success: false, message: err.message };
    }
    if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOTFOUND") || err.message.includes("timeout")) {
      return { success: false, message: "网络连接失败，无法访问 COROS 服务器" };
    }
    return { success: false, message: `COROS 绑定失败: ${err.message}` };
  }
}

/**
 * COROS session 刷新
 */
async function corosRefresh(openid, event) {
  try {
    const userRes = await db.collection("users").where({ openid }).get();
    if (userRes.data.length === 0) {
      return { success: false, message: "用户不存在" };
    }

    const user = userRes.data[0];
    const corosData = user.coros;

    if (!corosData || !corosData.bound || !corosData.email || !corosData.password) {
      return { success: false, message: "COROS 未绑定或凭证缺失，请重新绑定" };
    }

    // 解密数据库中的密码（兼容旧明文格式）
    const plainPassword = decryptPassword(corosData.password);
    const loginResult = await corosLogin(corosData.email, plainPassword);

    await saveCorosBindResult(openid, {
      accessToken: loginResult.accessToken,
      userId: loginResult.userId,
      regionId: loginResult.regionId,
      teamApi: loginResult.teamApi,
      displayName: loginResult.displayName,
      email: corosData.email,
      password: plainPassword,  // 传入明文，由 saveCorosBindResult 加密后存储
      expiresAt: loginResult.expiresAt,
    });

    return { success: true, data: { displayName: loginResult.displayName } };
  } catch (err) {
    console.error("corosRefresh error:", err);
    return { success: false, message: `COROS session 刷新失败: ${err.message}` };
  }
}

/**
 * 保存 COROS 绑定信息到数据库
 */
async function saveCorosBindResult(openid, data) {
  const platformUpdate = {
    bound: true,
    accessToken: data.accessToken,
    userId: data.userId || "",
    regionId: data.regionId || 2,
    teamApi: data.teamApi || "https://teamcnapi.coros.com",
    displayName: data.displayName,
    email: data.email,
    password: data.password ? encryptPassword(data.password) : "",
    expiresAt: data.expiresAt,
    updatedAt: new Date(),
  };

  const userRes = await db.collection("users").where({ openid }).get();
  if (userRes.data.length > 0) {
    const docId = userRes.data[0]._id;
    await db.collection("users").doc(docId).update({
      data: { coros: db.command.remove(), updatedAt: new Date() },
    });
    await db.collection("users").doc(docId).update({
      data: { coros: platformUpdate, updatedAt: new Date() },
    });
  } else {
    await db.collection("users").add({
      data: {
        openid,
        garminCn: { bound: false, oauth1: null, oauth2: null, displayName: "", username: "" },
        garminCom: { bound: false, oauth1: null, oauth2: null, displayName: "", username: "" },
        coros: platformUpdate,
        lastSyncTime: "",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }
}

function handleLoginError(err) {
  const msg = err.message || "未知错误";
  if (msg.includes("MFA") || msg.includes("mfa")) {
    return { success: false, message: "验证码验证失败，请重新获取" };
  }
  if (msg.includes("No ticket") || msg.includes("wrong password") || msg.includes("401")) {
    return { success: false, message: "账号或密码错误，请检查后重试" };
  }
  if (msg.includes("AccountLocked")) {
    return { success: false, message: "账号已锁定，请在网页端解锁" };
  }
  if (msg.includes("CSRF")) {
    return { success: false, message: "登录页面加载失败，请稍后重试" };
  }
  if (msg.includes("Update Phone")) {
    return { success: false, message: "需要更新手机号码，请在网页端更新后重试" };
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("timeout")) {
    return { success: false, message: "网络连接失败，无法访问 Garmin 服务器" };
  }
  return { success: false, message: `绑定失败: ${msg}` };
}
