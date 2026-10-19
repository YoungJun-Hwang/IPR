import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { loadBuffer } from 'cheerio';
import ipaddr from 'ipaddr.js';

export const MAX_BYTES = 2 * 1024 * 1024;
export class InputError extends Error {}
export function webURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new InputError('올바른 상품 URL을 입력해 주세요.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new InputError('인증 정보나 비표준 포트가 없는 http 또는 https URL을 입력해 주세요.');
  return url;
}
export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export async function publicTarget(value, resolve = dns.lookup) {
  const url = webURL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolve(host, { all:true, verbatim:true });
  if (!addresses.length || addresses.some(({address}) => !publicAddress(address))) throw new InputError('공개 인터넷의 상품 URL만 분석할 수 있습니다.');
  return { url, address:addresses[0].address, family:addresses[0].family };
}
function checkAbort(signal) { if (signal?.aborted) throw new InputError('분석 시간이 초과되었습니다. 상품 설명을 직접 입력해 주세요.'); }
async function resolveWithDeadline(url, signal) {
  checkAbort(signal);
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(new InputError('분석 시간이 초과되었습니다. 상품 설명을 직접 입력해 주세요.')); });
  signal?.addEventListener('abort', rejectAbort, {once:true});
  try { return await Promise.race([publicTarget(url), aborted]); }
  finally { signal?.removeEventListener('abort', rejectAbort); }
}
function readPinned(target, signal) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const {url, address, family} = target;
    const client = url.protocol === 'https:' ? https : http;
    // The hostname remains in Host/SNI for TLS; lookup only returns the validated IP.
    const req = client.request(url, {
      method:'GET', agent:false, signal,
      headers:{'User-Agent':'IPR-Review/0.1', 'Accept-Encoding':'identity'},
      lookup:(_host, options, callback) => {
        if (options?.all) callback(null, [{address, family}]);
        else callback(null, address, family);
      }
    }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.destroy();
        if (!location) reject(new InputError('이동할 주소가 없는 응답입니다.'));
        else resolve({redirect:new URL(location, url).href});
        return;
      }
      if (response.statusCode !== 200) {
        response.destroy(); reject(new InputError(`상품 페이지 요청이 거절되었습니다 (HTTP ${response.statusCode}). 상품 설명을 직접 입력해 주세요.`)); return;
      }
      if (Number(response.headers['content-length']) > MAX_BYTES) {
        response.destroy(); reject(new InputError('콘텐츠 크기는 2MB 이하여야 합니다.')); return;
      }
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding !== 'identity') {
        response.destroy(); reject(new InputError('압축 해제되지 않은 응답은 지원하지 않습니다. 상품 설명을 직접 입력해 주세요.')); return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(); reject(new InputError('콘텐츠 크기는 2MB 이하여야 합니다.')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({data:Buffer.concat(chunks), contentType:String(response.headers['content-type'] || '').toLowerCase(), url:url.href}));
      response.on('error', reject);
      response.on('aborted', () => reject(new InputError('상품 페이지 전송이 중단되었습니다.')));
    });
    req.setTimeout(8000, () => req.destroy(new InputError('상품 페이지 응답이 지연됩니다. 상품 설명을 직접 입력해 주세요.')));
    req.on('error', reject);
    req.end();
  });
}
export async function fetchPublic(value, accepted, signal) {
  let url = value;
  for (let i = 0; i < 4; i++) {
    const target = await resolveWithDeadline(url, signal);
    const response = await readPinned(target, signal);
    if (response.redirect) { url = response.redirect; continue; }
    if (!response.contentType.includes(accepted)) throw new InputError('지원하지 않는 콘텐츠 형식입니다.');
    return response;
  }
  throw new InputError('페이지 이동 횟수를 초과했습니다.');
}
export function normalize(text) { return text.replace(/\s+/gu, ' ').trim().toLowerCase(); }
export function compareText(brand, reference, product) {
  const normalized = normalize(product);
  const evidence = [];
  if (brand.trim() && normalized.includes(normalize(brand))) {
    const pos = normalized.indexOf(normalize(brand));
    evidence.push({kind:'브랜드명 일치', reference:brand, observed:normalized.slice(Math.max(0,pos-45),pos+brand.length+85)});
  }
  const segments = [...new Set(reference.split(/[\n.!?。]+/u).map(s => s.trim()).filter(s => normalize(s).length >= 12 && normalized.includes(normalize(s))))].slice(0,12);
  for (const match of segments) evidence.push({kind:'문구 일치', reference:match, observed:match});
  return evidence;
}
export function extractPage(data, url) {
  // loadBuffer detects the HTML-declared encoding, including Korean legacy pages.
  const $ = loadBuffer(data);
  const title = $('meta[property="og:title"]').first().attr('content') || $('title').first().text() || '상품 페이지';
  const images = [];
  $('meta[property="og:image"], img[src]').each((_i, tag) => {
    const src = $(tag).attr('content') || $(tag).attr('src');
    try { const full = new URL(src, url); if (['http:','https:'].includes(full.protocol) && !images.includes(full.href)) images.push(full.href); } catch {}
  });
  $('script, style, nav, footer, noscript').remove();
  $('br, p, h1, h2, h3, div, li, span, section, article, td').each((_i, tag) => { $(tag).append(' '); });
  return {title:title.slice(0,300), text:$.root().text().replace(/\s+/gu,' ').trim().slice(0,60000), images:images.slice(0,3)};
}
export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('입력 내용을 확인해 주세요.');
  const fields = {url:2048, brand:120, registration:300, reference_text:30000, reference_image:2800000, reference_filename:200, manual_text:30000};
  const body = {};
  for (const [name,max] of Object.entries(fields)) {
    const value = input[name] ?? '';
    if (typeof value !== 'string' || value.length > max) throw new InputError('입력 자료의 형식이나 길이를 확인해 주세요.');
    body[name] = value;
  }
  body.demo = input.demo === true;
  if (!body.url) throw new InputError('상품 URL을 입력해 주세요.');
  if (!body.brand.trim() && !body.reference_text.trim() && !body.reference_image) throw new InputError('브랜드명, 권리 문구, 원본 이미지 중 하나 이상을 등록해 주세요.');
  return body;
}
export async function analyze(input, {fetcher=fetchPublic, signal} = {}) {
  const body = validateInput(input);
  let image = null;
  if (body.reference_image) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.reference_image)) throw new InputError('원본 이미지 형식이 올바르지 않습니다.');
    image = Buffer.from(body.reference_image,'base64');
    if (image.length > MAX_BYTES) throw new InputError('원본 이미지는 2MB 이하여야 합니다.');
    const png = image.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
    const jpeg = image.subarray(0,3).equals(Buffer.from('ffd8ff','hex'));
    const gif = ['GIF87a','GIF89a'].includes(image.subarray(0,6).toString());
    const webp = image.subarray(0,4).toString() === 'RIFF' && image.subarray(8,12).toString() === 'WEBP';
    if (!png && !jpeg && !gif && !webp) throw new InputError('PNG, JPEG, GIF, WebP 이미지를 사용해 주세요.');
  }
  let title, text, images = [], source;
  const warnings = [];
  if (body.demo) {
    title = 'DEMO STUDIO · 시그니처 캔버스백';
    text = 'DEMO STUDIO 시그니처 캔버스백. 매일의 가벼움을 위한 오리지널 캔버스 디자인.';
    source = 'demo';
  } else if (body.manual_text.trim()) {
    webURL(body.url);
    title = '직접 입력한 상품 자료'; text = body.manual_text; source = 'manual';
    warnings.push('URL을 방문하지 않았습니다. 사용자가 입력한 상품 설명만 비교했습니다.');
  } else {
    let page;
    try { page = await fetcher(body.url, 'text/html', signal); }
    catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError('페이지를 가져오지 못했습니다. 네트워크 연결 또는 TLS 검증에 실패했습니다. 상품 설명을 직접 입력해 주세요.');
    }
    ({title, text, images} = extractPage(page.data, page.url)); source = 'url';
    warnings.push('공개 HTML만 확인했습니다. 로그인·자바스크립트로 표시되는 상품 정보는 누락될 수 있습니다.');
  }
  const evidence = compareText(body.brand, body.reference_text, text);
  let imageState = '미등록';
  if (image) {
    imageState = '미검증';
    if (!images.length) warnings.push('비교할 상품 이미지가 없어 이미지 일치 검사를 수행하지 않았습니다.');
    let checked = 0, matched = false;
    for (const url of images) {
      try {
        checkAbort(signal);
        const remote = await fetcher(url, 'image/', signal);
        checked++;
        if (createHash('sha256').update(remote.data).digest('hex') === createHash('sha256').update(image).digest('hex')) {
          matched = true;
          evidence.push({kind:'이미지 파일 동일', reference:body.reference_filename || '원본 이미지', observed:url});
        }
      } catch { warnings.push('상품 이미지 하나를 가져오지 못했습니다. 이미지 비교가 일부 누락되었습니다.'); }
    }
    if (checked) imageState = matched ? '동일 파일 확인' : '검사한 파일에서 동일 파일 없음';
    warnings.push('이미지는 최대 3개 파일의 SHA-256 동일성만 비교합니다. 크기·압축·편집이 다른 이미지의 시각적 유사성은 분석하지 않습니다.');
  }
  warnings.push('일치 여부는 침해 판단이 아닙니다. 정식 판매·이용 허락·권리 범위를 별도로 확인해 주세요. 등록번호는 기록용이며 공적 등록정보 조회는 수행하지 않습니다.');
  return {created:new Date().toISOString(), status:'검토 필요', notes:'', url:body.url, title, brand:body.brand, registration:body.registration, reference_text:body.reference_text, reference_filename:body.reference_filename, product_text:text, source, evidence, image_state:imageState, warnings, signal:evidence.length ? '검토할 일치 항목 있음' : '일치 근거 미발견'};
}
