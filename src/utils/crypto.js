/**
 * 加密工具 - 替代 Node.js crypto 模块
 * 使用 crypto-js 实现 MD5/SHA256/AES-256-CBC/HMAC-SHA1
 */
import CryptoJS from 'crypto-js'

// 固定加密密钥（与原云函数中相同）
const ENC_KEY = CryptoJS.SHA256('jjt-miniprogram-2024-enc')

/**
 * MD5 哈希（COROS 密码需要）
 */
export function md5(str) {
  return CryptoJS.MD5(str).toString(CryptoJS.enc.Hex)
}

/**
 * SHA256 哈希
 */
export function sha256(str) {
  return CryptoJS.SHA256(str).toString(CryptoJS.enc.Hex)
}

/**
 * HMAC-SHA1（OAuth 1.0a 签名需要）
 * 返回 base64 编码的字符串
 */
export function hmacSha1(baseString, key) {
  return CryptoJS.HmacSHA1(baseString, key).toString(CryptoJS.enc.Base64)
}

/**
 * AES-256-CBC 加密（替代 AES-256-GCM，安全性足够）
 * 格式: iv:ciphertext (全部 hex)
 */
export function encryptPassword(plain) {
  const iv = CryptoJS.lib.WordArray.random(16)
  const encrypted = CryptoJS.AES.encrypt(plain, ENC_KEY, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  })
  return iv.toString(CryptoJS.enc.Hex) + ':' + encrypted.ciphertext.toString(CryptoJS.enc.Hex)
}

/**
 * AES-256-CBC 解密
 */
export function decryptPassword(encrypted) {
  if (!encrypted || !encrypted.includes(':')) return encrypted
  const [ivHex, cipherHex] = encrypted.split(':')
  const iv = CryptoJS.enc.Hex.parse(ivHex)
  const cipherText = CryptoJS.enc.Hex.parse(cipherHex)
  const cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: cipherText })
  const decrypted = CryptoJS.AES.decrypt(cipherParams, ENC_KEY, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  })
  return decrypted.toString(CryptoJS.enc.Utf8)
}

/**
 * 将字符串转换为 WordArray (用于 CryptoJS 内部)
 */
export function toWordArray(str) {
  return CryptoJS.enc.Utf8.parse(str)
}

/**
 * 生成随机字节 hex 字符串
 */
export function randomHex(bytes = 16) {
  return CryptoJS.lib.WordArray.random(bytes).toString(CryptoJS.enc.Hex)
}
