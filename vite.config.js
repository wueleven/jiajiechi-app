import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 需要代理的外部域名 → Vite 代理路径
const PROXY_DOMAINS = {
  'sso.garmin.cn': 'https://sso.garmin.cn',
  'sso.garmin.com': 'https://sso.garmin.com',
  'connect.garmin.cn': 'https://connect.garmin.cn',
  'connect.garmin.com': 'https://connect.garmin.com',
  'connectapi.garmin.cn': 'https://connectapi.garmin.cn',
  'connectapi.garmin.com': 'https://connectapi.garmin.com',
  'thegarth.s3.amazonaws.com': 'https://thegarth.s3.amazonaws.com',
  'teamcnapi.coros.com': 'https://teamcnapi.coros.com',
  'teamapi.coros.com': 'https://teamapi.coros.com',
  'teameuapi.coros.com': 'https://teameuapi.coros.com',
  'faq.coros.com': 'https://faq.coros.com',
  // 对象存储：COROS 上传 FIT 文件的目标
  'oss-cn-beijing.aliyuncs.com': 'https://oss-cn-beijing.aliyuncs.com',
  's3.us-east-1.amazonaws.com': 'https://s3.us-east-1.amazonaws.com',
  's3.eu-central-1.amazonaws.com': 'https://s3.eu-central-1.amazonaws.com',
}

const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36'
const MOBILE_USER_AGENT = 'com.garmin.android.apps.connectmobile'

// 判断目标是否 Garmin 域名
function isGarmin(host) {
  return host && (host.includes('garmin.cn') || host.includes('garmin.com'))
}

// 构建 Vite proxy 配置
const proxy = {}
Object.keys(PROXY_DOMAINS).forEach(domain => {
  proxy[`/__proxy__/${domain}`] = {
    target: PROXY_DOMAINS[domain],
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(`/__proxy__/${domain}`, ''),
    configure: (proxyInstance) => {
      const targetHost = domain
      const protocol = PROXY_DOMAINS[domain].startsWith('https') ? 'https' : 'http'
      const origin = `${protocol}://${targetHost}`

      proxyInstance.on('proxyReq', (proxyReq, req) => {
        // 浏览器会覆盖 Origin/Referer/User-Agent，必须在代理层重新设置
        proxyReq.setHeader('Origin', origin)
        proxyReq.setHeader('Referer', `${origin}/`)

        // 对象存储（OSS/S3）的 PUT 请求带 Authorization 签名，
        // 签名计算包含 User-Agent，不能改动，否则 OSS 端重算签名不匹配 → 403
        const isObjectStore = targetHost.includes('oss-') || targetHost.includes('.s3.') || targetHost === 's3.amazonaws.com'
        if (!isObjectStore) {
          // 根据目标域名设置合适的 User-Agent
          if (targetHost.includes('connectapi.') || targetHost.includes('thegarth.')) {
            proxyReq.setHeader('User-Agent', MOBILE_USER_AGENT)
          } else {
            proxyReq.setHeader('User-Agent', DESKTOP_USER_AGENT)
          }
        } else {
          // OSS/S3 签名校验要求标准 Date 头必须存在且与签名中的值一致。
          // 浏览器对 Date 头处理不稳定（可能丢弃或改写），客户端改用 x-oss-date 传递签名时间。
          // 代理层把 x-oss-date 复制为 Date，确保 OSS 能收到正确的 Date。
          const ossDate = proxyReq.getHeader('x-oss-date') || req.headers['x-oss-date']
          if (ossDate) {
            // x-oss-date 是 ISO 8601 格式，需要转为 RFC 1123（OSS 期望的 Date 格式）
            try {
              const d = new Date(ossDate)
              if (!isNaN(d.getTime())) {
                proxyReq.setHeader('Date', d.toUTCString())
              }
            } catch (e) {
              console.warn('[proxy] failed to parse x-oss-date:', ossDate)
            }
          }
          // 调试：打印 OSS 签名相关头部
          console.log(`[proxy] ${req.method} ${targetHost}${req.url}`)
          console.log(`  x-oss-date: ${ossDate || '(none)'}`)
          console.log(`  Date (after proxy): ${proxyReq.getHeader('date')}`)
          console.log(`  Authorization: ${proxyReq.getHeader('authorization') || req.headers['authorization']}`)
          console.log(`  x-amz-security-token: ${(proxyReq.getHeader('x-amz-security-token') || req.headers['x-amz-security-token'] || '').substring(0, 40)}...`)
        }

        // 转发 Cookie 头（如果有）
        const cookie = req.headers['cookie']
        if (cookie) proxyReq.setHeader('Cookie', cookie)
      })

      // 处理浏览器发出的 CORS 预检（OPTIONS）请求：
      // 对象存储（OSS/S3）的 PUT 带 Authorization 等自定义头，会触发预检，
      // 目标服务器通常不响应 OPTIONS，必须由代理层直接返回 204 + CORS 头
      proxyInstance.on('proxyReq', (proxyReq, req, res) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400',
          })
          res.end()
          // 终止向目标服务器的转发
          if (typeof proxyReq.destroy === 'function') proxyReq.destroy()
        }
      })

      proxyInstance.on('proxyRes', (proxyRes, req, res) => {
        // 记录 OSS/S3 的错误响应体，便于排查签名问题
        const isObjectStore = targetHost.includes('oss-') || targetHost.includes('.s3.') || targetHost === 's3.amazonaws.com'
        if (isObjectStore && proxyRes.statusCode && proxyRes.statusCode >= 400) {
          const chunks = []
          const origWrite = res.write.bind(res)
          const origEnd = res.end.bind(res)
          res.write = (chunk) => { chunks.push(Buffer.from(chunk)); return origWrite(chunk) }
          res.end = (chunk) => {
            if (chunk) chunks.push(Buffer.from(chunk))
            try {
              const body = Buffer.concat(chunks).toString('utf8')
              console.error(`[proxy] ${req.method} ${targetHost}${req.url} → ${proxyRes.statusCode}\n${body}`)
            } catch (e) {}
            return origEnd()
          }
        }

        // 确保 Set-Cookie 头能被正确传递
        const setCookie = proxyRes.headers['set-cookie']
        if (setCookie) {
          proxyRes.headers['set-cookie'] = setCookie.map(c =>
            c.replace(/;\s*Domain=[^;]*/gi, '')
             .replace(/;\s*Path=[^;]*/gi, '')
             .replace(/;\s*SameSite=\w+/gi, '')
             .replace(/;\s*Secure/gi, '')
             .replace(/;\s*HttpOnly/gi, '')
          )
        }

        // 剥离目标服务器返回的 CORS 头，避免浏览器因域名不匹配而拦截响应
        delete proxyRes.headers['access-control-allow-origin']
        delete proxyRes.headers['access-control-allow-credentials']
        delete proxyRes.headers['access-control-allow-methods']
        delete proxyRes.headers['access-control-allow-headers']
        delete proxyRes.headers['access-control-expose-headers']

        // 补上允许跨域的 CORS 头（让浏览器能读到响应，特别是 PUT/DELETE 等非常规方法）
        proxyRes.headers['access-control-allow-origin'] = '*'
        proxyRes.headers['access-control-expose-headers'] = '*'

        // 重写 30x 重定向的 Location 头，让浏览器继续走代理路径
        const location = proxyRes.headers['location']
        if (location) {
          console.log(`[proxy] ${targetHost} ${proxyRes.statusCode} Location: ${location}`)
          try {
            const locUrl = new URL(location, `${protocol}://${targetHost}`)
            const proxyDomain = Object.keys(PROXY_DOMAINS).find(d => locUrl.host === d)
            if (proxyDomain) {
              const newLocation = `/__proxy__/${proxyDomain}${locUrl.pathname}${locUrl.search}`
              proxyRes.headers['location'] = newLocation
              console.log(`[proxy] rewritten Location: ${newLocation}`)
            }
          } catch (err) {
            console.error(`[proxy] failed to rewrite Location: ${err.message}`)
          }
        }
      })
    },
  }
})

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy,
  },
})
