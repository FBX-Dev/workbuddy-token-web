/* Cloudflare Worker：静态资源 + 访问统计（去重设备计数）
 *
 * 职责边界：
 *  - 静态资源由 assets 绑定直接下发（无 Worker 介入），看板全部在浏览器本地运行
 *  - 唯一动态接口 GET /api/visit?did=<设备id>，只做去重计数并返回总数
 *  - 不接收、不存储、不转发任何日志内容
 *
 * 隐私加固：Cloudflare 会在 HTML 响应里自动注入 Web Analytics（RUM）脚本，
 * 向 static.cloudflareinsights.com 发送访问信标。"数据不出本机"是本页面的核心承诺，
 * 任何第三方外发都会削弱它，因此这里主动剥离注入的 beacon 脚本。
 */

const CORS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: CORS });
}

/* 移除 Cloudflare 自动注入的 RUM/Web Analytics script 标签 */
function stripInjectedRum(html) {
  return html
    /* 整段 <script ... cloudflareinsights ...>...</script> */
    .replace(/<script\b[^>]*cloudflareinsights[^>]*>[\s\S]*?<\/script>/gi, '')
    /* 自闭合写法的兜底 */
    .replace(/<script\b[^>]*cloudflareinsights[^>]*\/?>/gi, '')
    /* 残留的 beacon 域名字符串兜底（含被拼接的情况） */
    .replace(/static\.cloudflareinsights\.com[^"'`\s]*/gi, '');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/visit') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS' }
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

    /* 静态资源走 assets，但对 HTML 响应做一次 RUM 剥离 */
    const res = await env.ASSETS.fetch(request);
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return res;

    const html = await res.text();
    const cleaned = stripInjectedRum(html);
    const headers = new Headers(res.headers);
    /* 长度已变，交给运行时重算 */
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(cleaned, { status: res.status, headers });
  }
};
