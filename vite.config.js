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
  // Zepp 华米（技术验证用）
  'api-user-us2.zepp.com': 'https://api-user-us2.zepp.com',
  'api-user-cn.zepp.com': 'https://api-user-cn.zepp.com',
  'api-mifit-us2.zepp.com': 'https://api-mifit-us2.zepp.com',
  'api-mifit-cn.zepp.com': 'https://api-mifit-cn.zepp.com',
  'api-mifit.zepp.com': 'https://api-mifit.zepp.com',
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

      proxyInstance.on('proxyReq', (proxyReq, req, res) => {
        // 浏览器会覆盖 Origin/Referer/User-Agent，代理层需修正
        const isObjectStore = targetHost.includes('oss-') || targetHost.includes('.s3.') || targetHost === 's3.amazonaws.com'
        const isZepp = targetHost.includes('zepp.com')
        if (isZepp) {
          // Zepp tokens 接口(对齐 huami-token)不发送 Origin/Referer，
          // 否则 us2 节点判定 Origin 非法 → 403。移除浏览器带来的这两个头。
          proxyReq.removeHeader('origin')
          proxyReq.removeHeader('referer')
          // 保留前端 zeppAuth.js 设置的 Zepp/Android UA
        } else {
          proxyReq.setHeader('Origin', origin)
          proxyReq.setHeader('Referer', `${origin}/`)
          if (isObjectStore) {
            // OSS/S3 签名校验要求标准 Date 头必须存在且与签名中的值一致。
            // 浏览器对 Date 头处理不稳定（可能丢弃或改写），客户端改用 x-oss-date 传递签名时间。
            // 代理层把 x-oss-date 复制为 Date，确保 OSS 能收到正确的 Date。
            const ossDate = proxyReq.getHeader('x-oss-date') || req.headers['x-oss-date']
            if (ossDate) {
              try {
                const d = new Date(ossDate)
                if (!isNaN(d.getTime())) {
                  proxyReq.setHeader('Date', d.toUTCString())
                }
              } catch (e) {
                console.warn('[proxy] failed to parse x-oss-date:', ossDate)
              }
            }
            console.log(`[proxy] ${req.method} ${targetHost}${req.url}`)
            console.log(`  x-oss-date: ${ossDate || '(none)'}`)
            console.log(`  Date (after proxy): ${proxyReq.getHeader('date')}`)
            console.log(`  Authorization: ${proxyReq.getHeader('authorization') || req.headers['authorization']}`)
            console.log(`  x-amz-security-token: ${(proxyReq.getHeader('x-amz-security-token') || req.headers['x-amz-security-token'] || '').substring(0, 40)}...`)
          } else {
            if (targetHost.includes('connectapi.') || targetHost.includes('thegarth.')) {
              proxyReq.setHeader('User-Agent', MOBILE_USER_AGENT)
            } else {
              proxyReq.setHeader('User-Agent', DESKTOP_USER_AGENT)
            }
          }
        }

        // 转发 Cookie 头（如果有）
        const cookie = req.headers['cookie']
        if (cookie) proxyReq.setHeader('Cookie', cookie)
      })

      proxyInstance.on('proxyRes', (proxyRes, req, res) => {
        // Zepp tokens 接口返回 303 + Location(含 token)。
        // 浏览器对 redirect:'manual' 的 303 会生成 opaque 响应(status=0, 读不到 location)，
        // 故在代理层把 303 改写为 200 + JSON{location}，浏览器直接读 JSON 即可。
        const loc = proxyRes.headers['location'] || ''
        if (proxyRes.statusCode === 303 && loc.includes('hm-registration/successsignin.html')) {
          const body = JSON.stringify({ location: loc })
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Content-Length', Buffer.byteLength(body))
          res.end(body)
          return
        }

        // 对所有响应（含 OPTIONS 预检和实际响应）补 CORS 头，
        // 否则带自定义头的请求（如 Zepp 的 app_name/x-hm-ekv）触发预检时，
        // 浏览器因缺 Access-Control-Allow-* 判定预检失败 → fetch 报 HTTP 0 / 网络错误
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD')
        res.setHeader('Access-Control-Allow-Headers', '*')
        res.setHeader('Access-Control-Expose-Headers', '*')
        res.setHeader('Access-Control-Max-Age', '86400')

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
    cors: true,
    proxy,
    // 浏览器对带自定义头的请求会先发 OPTIONS 预检。
    // http-proxy 的 proxyReq 事件无法可靠地写入 CORS 响应头（会被接管覆盖），
    // 故在此 middleware 层（早于 proxy）拦截所有 /__proxy__ 的 OPTIONS，
    // 直接返回 204 + CORS 头，确保浏览器预检通过。
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method === 'OPTIONS' && typeof req.url === 'string' && req.url.startsWith('/__proxy__/')) {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD')
          res.setHeader('Access-Control-Allow-Headers', '*')
          res.setHeader('Access-Control-Expose-Headers', '*')
          res.setHeader('Access-Control-Max-Age', '86400')
          res.statusCode = 204
          res.end()
          return
        }
        next()
      })
    },
  },
})
