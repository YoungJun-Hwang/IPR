import {analyze, InputError} from '../lib/analyze.mjs';
const json = (data, status = 200) => Response.json(data, {status, headers:{'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
const MAX_BODY = 3 * 1024 * 1024;
export default async function handler(request) {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path.endsWith('/api/health')) return json({status:'ok', storage:'browser'});
  if (request.method !== 'POST' || !path.endsWith('/api/analyze')) return json({detail:'지원하지 않는 API 요청입니다. 검토 기록은 이 브라우저에 저장됩니다.'},404);
  if (!request.headers.get('content-type')?.includes('application/json')) return json({detail:'JSON 형식으로 요청해 주세요.'},415);
  if (Number(request.headers.get('content-length')) > MAX_BODY) return json({detail:'요청 자료가 너무 큽니다.'},413);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 23000);
  try {
    if (!request.body) throw new InputError('입력 자료가 없습니다.');
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) { await reader.cancel(); return json({detail:'요청 자료가 너무 큽니다.'},413); }
      chunks.push(Buffer.from(value));
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new InputError('올바른 JSON 입력이 아닙니다.'); }
    return json(await analyze(input, {signal:controller.signal}));
  } catch (error) {
    return json({detail:error instanceof InputError ? error.message : '분석 중 오류가 발생했습니다. 상품 설명을 직접 입력해 다시 시도해 주세요.'},422);
  } finally { clearTimeout(timer); }
}
