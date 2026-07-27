/**
 * COROS 同步服务 - 从 garminSync 云函数中的 COROS 部分迁移
 * STS 凭证获取、ZIP 打包、S3/OSS 上传、COROS 导入通知、活动列表获取
 */
import { httpRequest, qsStringify } from './http.js'
import { md5, sha256, decryptPassword } from '../utils/crypto.js'
import { getCorosSession, COROS_REGION_API } from './corosAuth.js'
import CryptoJS from 'crypto-js'
import JSZip from 'jszip'

// COROS 区域配置
const COROS_REGION_CONFIG = {
  1: { teamapi: 'https://teamapi.coros.com',    bucket: 'coros-s3',  service: 'aws',    s3Endpoint: 'https://s3.us-east-1.amazonaws.com' },
  2: { teamapi: 'https://teamcnapi.coros.com',  bucket: 'coros-oss',  service: 'aliyun', s3Endpoint: 'https://oss-cn-beijing.aliyuncs.com' },
  3: { teamapi: 'https://teameuapi.coros.com',  bucket: 'eu-coros',   service: 'aws',    s3Endpoint: 'https://s3.eu-central-1.amazonaws.com' },
}

const COROS_FAQ_API = 'https://faq.coros.com'
const COROS_S3_SALT = '9y78gpoERW4lBNYL'
const COROS_APP_ID = '1660188068672619112'
const COROS_STS_SIGN = {
  1: 'E34EF0E34A498A54A9C3EAEFC12B7CAF',
  2: '9AD4AA35AAFEE6BB1E847A76848D58DF',
  3: '877571111A1EE5316E4B590103D4B5B3',
}

// ============ COROS 上传 ============

/**
 * 上传 FIT 文件到 COROS（完整的 S3/OSS 上传流程）
 * 流程：获取 STS 凭证 → 打包 ZIP → 上传到 S3/OSS → 通知 COROS 导入
 */
export async function uploadToCoros(fitData, filename, corosSession) {
  const fitArray = fitData instanceof Uint8Array ? fitData : new Uint8Array(fitData)
  const originalFilename = filename || 'activity.fit'
  const regionId = corosSession.regionId || 2
  const regionCfg = COROS_REGION_CONFIG[regionId] || COROS_REGION_CONFIG[2]
  const stsSign = COROS_STS_SIGN[regionId] || COROS_STS_SIGN[2]

  // 1. 获取 STS 临时凭证（按区域使用不同的 bucket/service/sign）
  const stsQuery = qsStringify({
    bucket: regionCfg.bucket,
    service: regionCfg.service,
    v: 2,
    app_id: COROS_APP_ID,
    sign: stsSign,
  })
  const stsRes = await httpRequest(`${COROS_FAQ_API}/openapi/oss/sts?${stsQuery}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    responseType: 'json',
    validateStatus: false,
  })

  if (stsRes.status !== 200 || !stsRes.data?.data?.credentials) {
    throw new Error(`获取 COROS STS 凭证失败: HTTP ${stsRes.status}`)
  }

  // STS 凭证是 base64 + salt 编码的
  const rawCredentials = stsRes.data.data.credentials
  const stripped = rawCredentials.replace(COROS_S3_SALT, '')
  const bucketData = JSON.parse(atob(stripped))

  console.log(`COROS STS obtained: region=${regionId}, bucket=${regionCfg.bucket}`)

  // 2. 计算 FIT 文件 MD5，打包成 ZIP
  const fitBlob = new Blob([fitArray])
  const md5Hash = await blobMd5(fitBlob)
  const zip = new JSZip()
  zip.file(`${md5Hash}/${originalFilename}`, fitArray, { createFolders: true })
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  const zipArrayBuffer = await zipBlob.arrayBuffer()

  // S3 远程路径
  const userId = corosSession.userId || ''
  if (!userId) throw new Error('COROS userId 缺失')
  const remoteFilename = `fit_zip/${userId}/${md5Hash}.zip`

  // 3. 上传 ZIP 到 S3/OSS
  await uploadToS3(
    zipArrayBuffer,
    remoteFilename,
    regionCfg,
    bucketData,
  )

  console.log(`COROS S3 upload done: ${remoteFilename} (${zipArrayBuffer.byteLength} bytes)`)

  // 4. 通知 COROS 导入
  const teamApi = corosSession.teamApi || regionCfg.teamapi
  const importBody = {
    source: 1,
    timezone: 32,
    bucket: regionCfg.bucket,
    md5: md5Hash,
    size: zipArrayBuffer.byteLength,
    object: remoteFilename,
    serviceName: regionCfg.service,
    oriFileName: originalFilename,
  }

  const formData = new FormData()
  formData.append('jsonParameter', JSON.stringify(importBody))

  const importRes = await httpRequest(`${teamApi}/activity/fit/import`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      accesstoken: corosSession.accessToken,
    },
    body: formData,
    responseType: 'json',
    validateStatus: false,
    timeout: 60000,
  })

  console.log('COROS import response:', JSON.stringify(importRes.data).substring(0, 500))

  const resData = importRes.data || {}
  const importData = resData.data || {}
  const result = resData.result
  // 参考 garmin-sync-coros：成功必须 result==='0000'（data.status==2 仅服务端内部标记，此处以 result 为准）
  const isSuccess = result === '0000' || resData.apiCode === '8E16FCC7'
  const isDuplicate = resData.message && (resData.message.includes('exist') || result === '1003')

  // HTTP 层失败（如网络/网关错误）直接抛出
  if (importRes.status !== 200) {
    throw new Error(`COROS 导入通知失败: HTTP ${importRes.status}`)
  }

  // 重复活动：视为跳过而非失败
  if (isDuplicate) {
    return { success: false, duplicate: true }
  }

  // COROS 在 HTTP 200 的 body 里返回业务错误码（如 1019 Access token is invalid）。
  // 必须显式判失败并抛出，让编排层识别 token 失效并触发刷新重试，绝不能静默返回 success:false。
  if (!isSuccess) {
    const msg = resData.message || `result=${result}`
    // message 中保留 'token' / 'invalid' 关键字，供 isCorosTokenError() 识别以触发刷新
    throw new Error(`COROS 导入失败: ${msg}`)
  }

  return { success: true, duplicate: false }
}

// ============ S3/OSS 上传（纯 JS 实现） ============

/**
 * 上传文件到 S3/OSS（使用预签名 URL 或 PUT with auth）
 */
async function uploadToS3(data, key, regionCfg, credentials) {
  const { bucket, s3Endpoint, service } = regionCfg
  const url = `${s3Endpoint}/${bucket}/${key}`

  // 对于阿里云 OSS 和 AWS S3，使用 STS token 的简单 PUT
  const now = new Date()
  const dateStr = now.toUTCString()
  const stsToken = credentials.SessionToken || credentials.SecurityToken

  const headers = {
    'Content-Type': 'application/zip',
  }

  if (service === 'aliyun') {
    // 阿里云 OSS：使用 OSS 签名 v1
    // 注意：
    // 1. 浏览器 Fetch 会丢弃 Date 头，改用 x-oss-date（必须是 GMT/RFC1123 格式，ISO 8601 无效）
    // 2. STS 临时凭证必须通过 x-oss-security-token 头传递（不是 x-amz-security-token）
    // 3. 所有 x-oss-* 头都要按字典序加入 stringToSign 的 CanonicalizedOSSHeaders 部分
    headers['x-oss-date'] = dateStr
    headers['x-oss-security-token'] = stsToken
    const stringToSign = `PUT\n\napplication/zip\n${dateStr}\nx-oss-date:${dateStr}\nx-oss-security-token:${stsToken}\n/${bucket}/${key}`
    const signature = await ossSign(stringToSign, credentials.SecretAccessKey || credentials.AccessKeySecret)
    headers['Authorization'] = `OSS ${credentials.AccessKeyId}:${signature}`
  } else {
    // AWS S3：使用 SigV4
    headers['x-amz-security-token'] = stsToken
    const sigV4 = await awsSigV4Sign(
      'PUT', url, data, credentials,
      regionCfg.s3Endpoint.includes('us-east-1') ? 'us-east-1' : 'eu-central-1',
      's3'
    )
    Object.assign(headers, sigV4)
    headers['Date'] = dateStr
  }

  const putRes = await httpRequest(url, {
    method: 'PUT',
    headers,
    body: data,
    responseType: 'text',
    validateStatus: false,
    timeout: 120000,
  })

  if (putRes.status >= 400) {
    const bodyStr = typeof putRes.data === 'string' ? putRes.data : JSON.stringify(putRes.data)
    console.error(`OSS PUT failed: ${putRes.status} ${key}`)
    console.error('OSS response body:', bodyStr)
    console.error('Request headers:', JSON.stringify(headers, null, 2))
    const err = new Error(`OSS PUT ${putRes.status}: ${bodyStr.substring(0, 500)}`)
    err.responseBody = bodyStr
    throw err
  }
}

/**
 * 阿里云 OSS 签名 v1
 */
async function ossSign(stringToSign, secretKey) {
  // 使用 WebCrypto HMAC-SHA1
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

/**
 * AWS SigV4 签名（简化版）
 */
async function awsSigV4Sign(method, url, body, credentials, region, service) {
  const urlObj = new URL(url)
  const now = new Date()
  const dateStamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
  const shortDate = dateStamp.substring(0, 8)

  const host = urlObj.host
  const payloadHash = await sha256ArrayBuffer(body)

  const headers = {
    'x-amz-date': dateStamp,
    'x-amz-security-token': credentials.SessionToken || credentials.SecurityToken,
    'x-amz-content-sha256': payloadHash,
    'host': host,
  }

  const signedHeaderKeys = Object.keys(headers).sort()
  const signedHeadersStr = signedHeaderKeys.join(';')
  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n'

  const canonicalRequest = [
    method, urlObj.pathname, urlObj.search.replace(/^\?/, ''),
    canonicalHeaders, signedHeadersStr, payloadHash,
  ].join('\n')

  const scope = `${shortDate}/${region}/${service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${dateStamp}\n${scope}\n${await sha256String(canonicalRequest)}`

  const signingKey = await getSigningKey(credentials.SecretAccessKey || credentials.AccessKeySecret, shortDate, region, service)
  const signature = await hmacHex(signingKey, stringToSign)

  return {
    'x-amz-date': dateStamp,
    'x-amz-security-token': credentials.SessionToken || credentials.SecurityToken,
    'x-amz-content-sha256': payloadHash,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${scope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`,
  }
}

async function sha256ArrayBuffer(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf instanceof ArrayBuffer ? buf : new Uint8Array(buf))
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function sha256String(str) {
  return sha256ArrayBuffer(new TextEncoder().encode(str))
}

async function getSigningKey(secretKey, dateStamp, region, service) {
  const encoder = new TextEncoder()
  const kDate = await hmacRaw(`AWS4${secretKey}`, dateStamp)
  const kRegion = await hmacRaw(kDate, region)
  const kService = await hmacRaw(kRegion, service)
  return hmacRaw(kService, 'aws4_request')
}

async function hmacRaw(key, data) {
  const encoder = new TextEncoder()
  const keyData = typeof key === 'string' ? encoder.encode(key) : key
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
}

async function hmacHex(key, data) {
  const sig = await hmacRaw(key, data)
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 计算 Blob 的 MD5（直接使用 crypto-js，WebCrypto 不支持 MD5）
 */
async function blobMd5(blob) {
  const buffer = await blob.arrayBuffer()
  const wordArray = CryptoJS.lib.WordArray.create(new Uint8Array(buffer))
  return CryptoJS.MD5(wordArray).toString()
}

// ============ COROS 活动列表 & 下载 ============

/**
 * 从 COROS 获取活动列表
 */
export async function fetchCorosActivities(corosSession, pageNo = 1, pageSize = 20) {
  const teamApi = corosSession.teamApi
  // COROS API 参数名: size, pageNumber（不是 pageSize, pageNo），参数名错误会返回 Parameter input error
  const url = `${teamApi}/activity/query?size=${pageSize}&pageNumber=${pageNo}`

  console.log(`[coros] fetchActivities: url=${url}`)
  console.log(`[coros] fetchActivities: token=${(corosSession.accessToken || '').substring(0, 20)}..., userId=${corosSession.userId}, regionId=${corosSession.regionId}`)

  const res = await httpRequest(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      accesstoken: corosSession.accessToken,
    },
    responseType: 'json',
    validateStatus: false,
  })

  console.log(`[coros] fetchActivities: status=${res.status}, resp=${JSON.stringify(res.data).substring(0, 500)}`)

  if (res.status !== 200) {
    throw new Error(`COROS 活动列表请求失败: HTTP ${res.status}`)
  }

  const respData = res.data || {}
  const isSuccess = respData.result === '0000' || respData.apiCode === 'B747D36D'
  if (!isSuccess) {
    throw new Error(`COROS 活动列表返回错误: ${respData.message || '未知'}`)
  }

  const dataList = respData.data?.dataList || respData.data?.data || []

  return dataList.map(act => ({
    activityId: String(act.labelId || act.activityId || act.id || ''),
    activityName: act.label || act.activityName || act.sportName || '未知活动',
    startTimeLocal: act.startTime ? formatCorosTime(act.startTime) : '',
    sportType: act.sportType || 0,
    corosRaw: act,
  }))
}

/**
 * 从 COROS 下载 FIT 文件
 */
export async function downloadCorosFit(corosSession, activityId, sportType) {
  const teamApi = corosSession.teamApi

  // COROS 下载接口: /activity/detail/download，需要 labelId、sportType、fileType
  const dlUrl = `${teamApi}/activity/detail/download?labelId=${activityId}&sportType=${sportType || 0}&fileType=4`
  console.log(`[coros] downloadFit: ${dlUrl}`)

  const dlRes = await httpRequest(dlUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      accesstoken: corosSession.accessToken,
    },
    responseType: 'json',
    validateStatus: false,
  })

  if (dlRes.status !== 200) {
    throw new Error(`COROS FIT 下载请求失败: HTTP ${dlRes.status}`)
  }

  let downloadUrl = ''
  const respData = dlRes.data || {}
  if (typeof respData.data === 'string') downloadUrl = respData.data
  else if (respData.data?.fileUrl) downloadUrl = respData.data.fileUrl
  else if (respData.data?.url) downloadUrl = respData.data.url

  if (!downloadUrl) {
    throw new Error('COROS FIT 下载失败: 无法获取下载链接')
  }

  // 下载文件
  const fileRes = await httpRequest(downloadUrl, {
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 30000,
  })

  const fileBuffer = fileRes.data
  const byteArray = new Uint8Array(fileBuffer)
  console.log(`COROS FIT download: size=${byteArray.length} bytes`)

  // 检查是否是 zip
  if (byteArray[0] === 0x50 && byteArray[1] === 0x4b) {
    const zip = await JSZip.loadAsync(fileBuffer)
    const files = Object.keys(zip.files)
    const fitFile = files.find(f => f.endsWith('.fit')) || files[0]
    const fitData = await zip.files[fitFile].async('uint8array')
    return { path: fitFile, data: fitData }
  }

  return { path: `${activityId}.fit`, data: byteArray }
}

// ============ 辅助 ============

function formatCorosTime(timeStr) {
  if (!timeStr) return ''
  if (typeof timeStr === 'number') {
    const d = new Date(timeStr)
    return d.toISOString().replace('T', ' ').substring(0, 19)
  }
  return String(timeStr).substring(0, 19)
}
