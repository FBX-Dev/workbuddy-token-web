/* Cloudflare Worker：静态资源 + 访问统计（去重设备计数）
 *
 * 职责边界：
 *  - 静态资源由 assets 绑定直接下发（无 Worker 介入），看板全部在浏览器本地运行
 *  - 唯一动态接口 GET /api/visit?did=<设备id>，只做去重计数并返回总数
 *  - 不接收、不存储、不转发任何日志内容
 */

const CORS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: CORS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/api/visit') {
      /* 其余路径交给静态资源绑定 */
      return env.ASSETS.fetch(request);
    }

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
        /* 新设备：写入并按计数器自增 */
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
};
