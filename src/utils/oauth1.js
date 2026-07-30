/**
 * OAuth 1.0a 签名实现 - 替代 oauth-1.0a 库
 * 纯 JavaScript 实现，不依赖 Node.js
 */
import { hmacSha1, randomHex } from './crypto.js'

/**
 * 创建 OAuth 1.0a 客户端
 * @param {Object} consumer - { key, secret }
 */
export function createOAuthClient(consumer) {
  return {
    consumer,

    /**
     * 生成 OAuth 签名和参数
     * @param {Object} requestData - { url, method, data }
     * @param {Object} token - { key, secret } (可选)
     * @returns {Object} 包含所有 OAuth 参数的对象
     */
    authorize(requestData, token) {
      const { url, method } = requestData
      const oauthParams = {
        oauth_consumer_key: consumer.key,
        oauth_nonce: randomHex(16),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_version: '1.0',
      }

      if (token) {
        oauthParams.oauth_token = token.key
      }

      // 合并所有参数（OAuth + query + body）用于签名
      const allParams = { ...oauthParams }

      // 解析 URL 中的 query 参数
      const urlObj = new URL(url)
      urlObj.searchParams.forEach((value, key) => {
        allParams[key] = value
      })

      // 生成签名基础字符串
      const baseString = buildBaseString(method.toUpperCase(), normalizeUrl(url), allParams)

      // 生成签名密钥
      const signingKey = percentEncode(consumer.secret) + '&' + percentEncode(token ? token.secret : '')

      // 生成签名
      oauthParams.oauth_signature = hmacSha1(baseString, signingKey)

      return oauthParams
    },

    /**
     * 生成 Authorization header
     */
    toHeader(oauthParams) {
      const headerParts = Object.keys(oauthParams)
        .filter(k => k.startsWith('oauth_'))
        .sort()
        .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      return { Authorization: 'OAuth ' + headerParts.join(', ') }
    },
  }
}

function normalizeUrl(url) {
  const urlObj = new URL(url)
  return urlObj.origin + urlObj.pathname
}

function buildBaseString(method, baseUrl, params) {
  const sortedParams = Object.keys(params)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&')
  return `${method}&${percentEncode(baseUrl)}&${percentEncode(sortedParams)}`
}

function percentEncode(str) {
  if (str === null || str === undefined) return ''
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/'/g, '%27')
}
