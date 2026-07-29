/**
 * HTTP 客户端 - 替代 axios
 * 在 Capacitor App 环境中使用 CapacitorHttp (绕过 CORS)
 * 在 H5 开发环境中使用 fetch
 *
 * 核心功能：cookie 跟踪、手动重定向控制、arraybuffer 响应、表单提交
 */
import { CapacitorHttp, Capacitor, CapacitorCookies } from '@capacitor/core'

// 检测是否在原生环境运行
function isNative() {
  return Capacitor.isNativePlatform()
}

// 开发模式下需要将外部 URL 路由到 Vite 代理以绕过 CORS
const PROXY_PREFIX = '/__proxy__/'

function rewriteUrl(url) {
  // 原生环境或生产环境不需要代理
  if (isNative() || !import.meta.env.DEV) return url
  try {
    const parsed = new URL(url)
    // 只代理外部域名（非 localhost）
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return url
    return `${PROXY_PREFIX}${parsed.host}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

// Cookie 存储：按域名管理
const cookieStore = {}

function getDomainFromUrl(url) {
  try {
    return new URL(url).hostname
  } catch { return '' }
}

/**
 * 拆分合并后的 Set-Cookie 头
 * Android CapacitorHttp 会把多个 Set-Cookie 用 ", " 连接成一个字符串，
 * 需要按 "逗号 + cookie名=" 的边界拆分（Expires=Mon, 27 Jul 2026 中的逗号不会被误拆）
 */
function splitSetCookieHeader(combined) {
  return combined
    .split(/\n|,(?=\s*[^\s;,=]+=)/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 设置 cookie（从 Set-Cookie 头解析）
 */
function parseAndStoreCookies(setCookieHeaders, url) {
  if (!setCookieHeaders) return
  const domain = getDomainFromUrl(url)
  if (!cookieStore[domain]) cookieStore[domain] = {}

  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]
  headers.forEach(header => {
    const nameValue = header.split(';')[0].trim()
    const eqIdx = nameValue.indexOf('=')
    if (eqIdx > 0) {
      const name = nameValue.substring(0, eqIdx)
      cookieStore[domain][name] = nameValue
    }
  })
}

/**
 * 获取指定 URL 域名的所有 cookie
 */
export function getCookiesForUrl(url) {
  const domain = getDomainFromUrl(url)
  const cookies = cookieStore[domain] || {}
  return Object.values(cookies).join('; ')
}

/**
 * 清空指定域名的 cookie
 */
export function clearCookies(domain) {
  if (domain) {
    delete cookieStore[domain]
  } else {
    Object.keys(cookieStore).forEach(k => delete cookieStore[k])
  }
}

/**
 * 清空原生 CookieManager 中指定 URL 的 cookie
 * 原生环境下 CapacitorCookies 设置了全局 CookieHandler，
 * 请求会自动附加 WebView CookieManager 中的 cookie，必须一并清理
 */
export async function clearNativeCookies(url) {
  if (!isNative()) return
  try {
    await CapacitorCookies.clearCookies({ url })
  } catch (e) {
    console.warn('clearNativeCookies failed:', e)
  }
}

/**
 * 通用 HTTP 请求函数
 * @param {string} url - 请求 URL
 * @param {Object} options
 * @param {string} options.method - GET/POST/PUT/DELETE
 * @param {Object} options.headers - 请求头
 * @param {*} options.body - 请求体
 * @param {boolean} options.followRedirect - 是否自动跟随重定向 (默认 true)
 * @param {number} options.maxRedirects - 最大重定向次数 (默认 10)
 * @param {string} options.responseType - 'text' | 'json' | 'arraybuffer' | 'blob'
 * @param {number} options.timeout - 超时时间 ms (默认 30000)
 * @param {boolean} options.validateStatus - 是否对非 2xx 状态抛错 (默认 true)
 * @returns {Object} { status, headers, data }
 */
export async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    responseType = 'json',
    timeout = 30000,
    validateStatus = true,
    followRedirect = true,
  } = options

  // 自动附加 cookie（Web 模式由浏览器自动管理，不需要手动设置）
  const cookieStr = getCookiesForUrl(url)
  const mergedHeaders = { ...headers }
  if (isNative() && cookieStr && !mergedHeaders['Cookie']) {
    mergedHeaders['Cookie'] = cookieStr
  }

  const fetchUrl = rewriteUrl(url)

  if (isNative()) {
    return nativeRequest(url, method, mergedHeaders, body, responseType, timeout, validateStatus, followRedirect)
  }

  // Web 环境使用 fetch（开发模式通过代理，自动跟随重定向）
  return webRequest(url, fetchUrl, method, mergedHeaders, body, responseType, timeout, validateStatus)
}

// ============ 原生 HTTP (CapacitorHttp) ============

async function nativeRequest(url, method, headers, body, responseType, timeout, validateStatus, followRedirect = true) {
  const upperMethod = method.toUpperCase()
  // 二进制下载 或 带文件/表单的上传 优先使用 WebView fetch：
  // 避免 CapacitorHttp 桥接层把 FormData 里的二进制文件转成 JSON，导致 415 Unsupported Media Type
  // 同时避免把 Uint8Array/ArrayBuffer 二进制 body 转成 base64 文本，导致阿里云 OSS 收到损坏内容（网页成功、APK 失败的根因）
  const useFetch = responseType === 'arraybuffer' || body instanceof FormData ||
    body instanceof Uint8Array || body instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && body instanceof Blob)
  if (useFetch) {
    try {
      // FormData 上传时让 WebView 自动设置 multipart/form-data 的 boundary，
      // 因此移除调用方可能误设的 Content-Type
      const fetchHeaders = { ...headers }
      let fetchBody = body
      if (body instanceof FormData) {
        delete fetchHeaders['Content-Type']
        delete fetchHeaders['content-type']
      } else if (
        body instanceof Uint8Array || body instanceof ArrayBuffer ||
        (typeof Blob !== 'undefined' && body instanceof Blob && !(typeof File !== 'undefined' && body instanceof File))
      ) {
        // 关键：capacitor.config.json 开启 CapacitorHttp 后，真机上 window.fetch 被 Capacitor 劫持，
        // 其桥接层 convertBody 对 Uint8Array/ArrayBuffer body 用 TextDecoder 按 UTF-8 解码，
        // 任意二进制（如 zip）会被不可逆损坏，而 OSS v1 签名不校验文件内容仍返回 200，
        // 导致“同步显示成功但高驰没数据”（网页正常、APK 失败的真正根因）。
        // 桥接层只有 File 类型走 base64 无损通道（Java 侧 Base64.decode 还原原始字节），
        // 所以这里把二进制 body 包装成 File 再交给 fetch
        const ct = fetchHeaders['Content-Type'] || fetchHeaders['content-type'] || 'application/octet-stream'
        fetchBody = new File([body], 'upload.bin', { type: ct })
        console.log(`[http] binary body wrapped as File (${fetchBody.size} bytes, ${ct}) for lossless native upload`)
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const fetchRes = await fetch(url, {
        method: upperMethod,
        headers: fetchHeaders,
        body: fetchBody && upperMethod !== 'GET' ? fetchBody : undefined,
        redirect: followRedirect !== false ? 'follow' : 'manual',
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (validateStatus && fetchRes.status >= 400) {
        const err = new Error(`HTTP ${fetchRes.status}`)
        err.status = fetchRes.status
        throw err
      }

      // 收集 Set-Cookie
      const setCookie = fetchRes.headers.get('set-cookie') || fetchRes.headers.get('Set-Cookie') || ''
      if (setCookie) parseAndStoreCookies([setCookie], url)

      const respHeaders = {}
      fetchRes.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v })

      // 根据 responseType 解析响应体
      let data
      if (responseType === 'arraybuffer') {
        data = await fetchRes.arrayBuffer()
        console.log(`[http] fetch binary OK: ${data.byteLength} bytes from ${url}`)
      } else if (responseType === 'text') {
        data = await fetchRes.text()
      } else {
        // json（默认）：先读 text 再解析，避免 json() 失败后无法回退
        const text = await fetchRes.text()
        try { data = JSON.parse(text) } catch { data = text }
      }

      return { status: fetchRes.status, headers: respHeaders, data, url: fetchRes.url || url }
    } catch (fetchErr) {
      // 验证性错误（如 4xx/5xx）直接抛出，不回退
      if (fetchErr.status) throw fetchErr
      // 其他错误（CORS/网络等）回退到 CapacitorHttp
      console.warn(`[http] fetch failed (${fetchErr.message}), falling back to CapacitorHttp`)
    }
  }
  const requestData = {
    url,
    method: upperMethod,
    headers,
    connectTimeout: timeout,
    readTimeout: timeout,
    // 关键：登录/MFA 流程需要手动处理 302，禁用原生自动重定向
    disableRedirects: !followRedirect,
  }

  // 处理请求体
  if (body && upperMethod !== 'GET') {
    if (typeof body === 'string') {
      requestData.data = body
    } else if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      // 二进制数据转 base64
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
      let binary = ''
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      requestData.data = btoa(binary)
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/octet-stream'
      }
    } else if (body instanceof FormData) {
      // FormData 转 JSON（CapacitorHttp 不直接支持 FormData）
      const formDataObj = {}
      body.forEach((value, key) => { formDataObj[key] = value })
      requestData.data = formDataObj
    } else if (typeof body === 'object') {
      requestData.data = body
    }
  }

  let capResponse

  // DNS 解析失败发生在请求发出之前（未触达服务器），重试不会产生重复副作用；
  // 批量同步时手机网络瞬时抖动偶发此错误，自动重试一次避免整条活动被标记失败
  const isDnsFailure = (e) => /Unable to resolve host|No address associated|UnknownHostException/i.test(e?.message || String(e))

  for (let attempt = 0; ; attempt++) {
    try {
      switch (upperMethod) {
        case 'GET':
          capResponse = await CapacitorHttp.get(requestData)
          break
        case 'POST':
          capResponse = await CapacitorHttp.post(requestData)
          break
        case 'PUT':
          capResponse = await CapacitorHttp.put(requestData)
          break
        case 'DELETE':
          capResponse = await CapacitorHttp.delete(requestData)
          break
        default:
          capResponse = await CapacitorHttp.request(requestData)
      }
      break
    } catch (err) {
      if (attempt < 1 && isDnsFailure(err)) {
        console.warn(`[http] DNS 解析失败，1.5s 后重试: ${url}`)
        await new Promise(r => setTimeout(r, 1500))
        continue
      }
      throw new Error(`原生 HTTP 请求失败: ${err.message || err}`)
    }
  }

  // 解析响应头中的 Set-Cookie
  const respHeaders = capResponse.headers || {}
  const setCookie = respHeaders['set-cookie'] || respHeaders['Set-Cookie'] || ''
  if (setCookie) {
    parseAndStoreCookies(
      Array.isArray(setCookie) ? setCookie : splitSetCookieHeader(setCookie),
      url
    )
  }

  // 转换响应格式
  const responseHeaders = {}
  Object.entries(respHeaders).forEach(([k, v]) => {
    responseHeaders[k.toLowerCase()] = v
  })

  let data = capResponse.data
  const status = capResponse.status || 200

  // 根据 responseType 处理数据
  if (responseType === 'arraybuffer') {
    if (typeof data === 'string') {
      // base64 转 ArrayBuffer（CapacitorHttp 常见返回格式）
      try {
        // 修复 base64 padding：缺少填充时补齐，避免解码截断
        let b64 = data
        const mod4 = b64.length % 4
        if (mod4 === 2) b64 += '=='
        else if (mod4 === 3) b64 += '='
        else if (mod4 === 1) b64 += '===' // 异常但尝试

        const binary = atob(b64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
        data = bytes.buffer
        console.log(`[http] arraybuffer from base64: input=${data.length}chars, output=${bytes.byteLength}bytes`)
      } catch (e) {
        console.warn('[http] base64 decode failed, trying UTF-8:', e.message)
        // 如果不是 base64，尝试 UTF-8 编码
        const encoder = new TextEncoder()
        data = encoder.encode(data).buffer
      }
    } else if (data instanceof ArrayBuffer) {
      // 已经是 ArrayBuffer，直接使用
      console.log(`[http] arraybuffer direct: ${data.byteLength} bytes`)
    } else if (ArrayBuffer.isView(data)) {
      // Uint8Array / Int8Array 等 TypedArray，提取底层 buffer
      const byteLength = data.byteLength
      data = data.buffer.slice(data.byteOffset, data.byteOffset + byteLength)
      console.log(`[http] arraybuffer from TypedArray: ${byteLength} bytes`)
    } else if (Array.isArray(data)) {
      // JSON 数字数组（Capacitor 桥接层可能将 byte[] 序列化为 JSON array）
      data = new Uint8Array(data).buffer
      console.log(`[http] arraybuffer from Array: ${data.byteLength} bytes`)
    } else if (data && typeof data === 'object') {
      // 其他对象格式（如 { "0": 80, "1": 75, ... } 字节映射），尝试提取数值
      const values = Object.values(data)
      if (values.length > 0 && values.every(v => typeof v === 'number')) {
        data = new Uint8Array(values).buffer
        console.log(`[http] arraybuffer from Object values: ${data.byteLength} bytes`)
      } else {
        // 无法转成二进制：明确报错，避免把损坏对象透传给下游当作 FIT/zip 误用
        throw new Error('arraybuffer 响应无法解析为二进制（对象含非数值或为空）')
      }
    }
  } else if (responseType === 'json' && typeof data === 'string') {
    try { data = JSON.parse(data) } catch { /* 保持字符串 */ }
  }

  // capResponse.url 是重定向后的最终 URL（跟随重定向时可用于提取 ticket 等参数）
  const result = { status, headers: responseHeaders, data, url: capResponse.url || url }

  if (validateStatus && status >= 400) {
    const err = new Error(`HTTP ${status}`)
    err.response = result
    err.status = status
    throw err
  }

  return result
}

// ============ Web HTTP (fetch) ============

async function webRequest(originalUrl, fetchUrl, method, headers, body, responseType, timeout, validateStatus) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const fetchOptions = {
      method: method.toUpperCase(),
      headers,
      redirect: 'follow',
      signal: controller.signal,
    }

    if (body && method.toUpperCase() !== 'GET') {
      fetchOptions.body = body
    }

    const response = await fetch(fetchUrl, fetchOptions)
    clearTimeout(timeoutId)

    // 收集 set-cookie（用原始域名存储）
    const setCookie = response.headers.get('set-cookie') ||
      response.headers.get('Set-Cookie') || ''
    if (setCookie) {
      parseAndStoreCookies([setCookie], originalUrl)
    }

    const result = await buildResponse(response, originalUrl, responseType)
    // 返回最终 URL（浏览器跟随重定向后的地址）
    result.url = response.url

    if (validateStatus && response.status >= 400) {
      const err = new Error(`HTTP ${response.status}`)
      err.response = result
      err.status = response.status
      throw err
    }

    return result
  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      throw new Error(`请求超时 (${timeout}ms)`)
    }
    throw err
  }
}

async function buildResponse(response, url, responseType) {
  const headers = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  let data
  switch (responseType) {
    case 'arraybuffer':
      data = await response.arrayBuffer()
      break
    case 'blob':
      data = await response.blob()
      break
    case 'text':
      data = await response.text()
      break
    case 'json':
    default:
      // 先读 text 再解析 JSON，避免 json() 失败后 body 已被消费无法回退
      try {
        const text = await response.text()
        try {
          data = JSON.parse(text)
        } catch {
          data = text // 不是 JSON，保持原始文本
        }
      } catch (e) {
        console.warn('[http] response read failed:', e.message)
        data = null
      }
      break
  }

  return {
    status: response.status,
    headers,
    data,
    url,
  }
}

/**
 * 便捷方法：URL-encoded 表单参数序列化
 */
export function qsStringify(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

/**
 * 便捷方法：URL-encoded 表单参数解析
 */
export function qsParse(str) {
  const result = {}
  str.split('&').forEach(part => {
    const [k, v] = part.split('=')
    if (k) result[decodeURIComponent(k)] = v ? decodeURIComponent(v) : ''
  })
  return result
}
