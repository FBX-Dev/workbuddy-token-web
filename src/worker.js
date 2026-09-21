/* Cloudflare Worker：静态资源 + 访问统计（去重设备计数）
 *
 * 职责边界：
 *  - 静态资源由 assets 绑定直接下发（无 Worker 介入），看板全部在浏览器本地运行
 *  - 唯一动态接口 GET /api/visit?did=<设备id>，只做去重计数并返回总数
 *  - 不接收、不存储、不转发任何日志内容
 *
 * 隐私加固（两道防线，针对 Cloudflare 自动注入的 Web Analytics / RUM 信标）：
 *
 *  注入形态：CF 在 HTML 响应末尾（</body> 之前）追加
 *    <script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/..."
 *            integrity="..." data-cf-beacon='{"token":"..."}' crossorigin="anonymous"></script>
 *  并在运行时向同域 /cdn-cgi/rum 回传。该注入发生在比 Worker 更靠外的边缘层，
 *  Worker 从 ASSETS 读到的响应里并不含它，因此仅靠剥离字符串无法拦截。
 *
 *  第一道防线（真正生效）：public/_headers 下发的 CSP
 *    script-src 'self' 'unsafe-inline'  —— 禁掉 static.cloudflareinsights.com 的脚本加载
 *    connect-src 'self'                  —— 即便脚本落地，也发不出信标
 *    由浏览器强制执行，不依赖 Cloudflare 账号设置或令牌权限。
 *
 *  第二道防线（纵深防御）：本文件把响应里出现的一切 beacon 痕迹清掉，
 *    并对非 HTML 也补上安全响应头。若将来部署形态变化（注入发生在 Worker 之内），
 *    这里仍能保证页面上不出现任何第三方域名。
 */

const CORS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: CORS });
}

/* 安全响应头（与 public/_headers 一致，Worker 侧再兜一层） */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'"
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), serial=(), hid=()',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY'
};

function withSecurityHeaders(headers) {
  for (const k of Object.keys(SECURITY_HEADERS)) headers.set(k, SECURITY_HEADERS[k]);
  return headers;
}

/* 纵深防御：清掉响应里一切 Cloudflare RUM / Web Analytics 痕迹
 * 覆盖三种形态：完整成对标签、自闭合标签、以及裸露的 beacon URL 字符串。
 * 若注入发生在本 Worker 之后（当前线上就是这个形态），则由 CSP 兜底拦截。 */
function stripInjectedRum(html) {
  return html
    /* <script ...cloudflareinsights...>...</script> */
    .replace(/<script\b[^>]*cloudflareinsights[^>]*>[\s\S]*?<\/script>/gi, '')
    /* <script ...cloudflareinsights... /> */
    .replace(/<script\b[^>]*cloudflareinsights[^>]*\/?>/gi, '')
    /* 带 data-cf-beacon 的标签（不依赖域名是否出现） */
    .replace(/<script\b[^>]*data-cf-beacon[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*data-cf-beacon[^>]*\/?>/gi, '')
    /* 兜底：清掉 beacon 域名与信标回传路径的残留字符串 */
    .replace(/https?:\/\/static\.cloudflareinsights\.com[^"'`\s>]*/gi, '')
    .replace(/\/cdn-cgi\/rum[^"'`\s>]*/gi, '')
    .replace(/\sdata-cf-beacon=('[^']*'|"[^"]*")/gi, '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/visit') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,OPTIONS',
            ...SECURITY_HEADERS
          }
        });
      }
      if (request.method !== 'GET') {
        return json({ error: 'method not allowed' }, 405);
      }

      const did = (url.searchParams.get('did') || '').trim();
      /* 设备 ID 由前端生成，只接受受限字符集，长度上限 40 */
      if (!/^[a-z0-9]{8,40}$/.test(did)) {
        return json({ error: 'invalid device id' }, 400);
      }

      try {
        const key = 'dev:' + did;
        const seen = await env.TOKEN_VISITS.get(key);
        let total;
        if (seen) {
          total = parseInt(seen, 10) || 0;
        } else {
          await env.TOKEN_VISITS.put(key, '1', { expirationTtl: 60 * 60 * 24 * 365 * 3 });
          const cur = await env.TOKEN_VISITS.get('total');
          total = (parseInt(cur, 10) || 0) + 1;
          await env.TOKEN_VISITS.put('total', String(total));
        }
        return json({ count: total });
      } catch (e) {
        /* 统计失败不影响看板主功能 */
        return json({ error: 'unavailable' }, 503);
      }
    }

    /* 静态资源走 assets；HTML 额外做一次 RUM 剥离 */
    const res = await env.ASSETS.fetch(request);
    const ct = res.headers.get('content-type') || '';
    const headers = withSecurityHeaders(new Headers(res.headers));

    if (!ct.includes('text/html')) {
      return new Response(res.body, { status: res.status, headers });
    }

    const html = await res.text();
    const cleaned = stripInjectedRum(html);
    /* 长度已变，交给运行时重算 */
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(cleaned, { status: res.status, headers });
  }
};
