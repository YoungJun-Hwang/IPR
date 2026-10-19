import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze, compareText, publicAddress, publicTarget, extractPage, webURL, InputError, validateInput} from '../../netlify/lib/analyze.mjs';
import handler from '../../netlify/functions/api.mjs';

test('sample analysis reports exact evidence without network access', async () => {
  const data = await analyze({url:'https://example.com', brand:'DEMO STUDIO', reference_text:'매일의 가벼움을 위한 오리지널 캔버스 디자인', demo:true}, {fetcher:() => {throw Error('unexpected network');}});
  assert.equal(data.source,'demo');
  assert.deepEqual(data.evidence.map(e=>e.kind),['브랜드명 일치','문구 일치']);
  assert.equal(data.status,'검토 필요');
});
test('manual no-match does not claim non-infringement', async () => {
  const result = await analyze({url:'https://example.com', brand:'원본', manual_text:'다른 브랜드 상품입니다'});
  assert.equal(result.signal,'일치 근거 미발견');
  assert.equal(result.source,'manual');
  assert.match(result.warnings.join(' '),/URL을 방문하지 않았습니다/);
});
test('public HTML, reference text and exact image bytes are compared', async () => {
  const image = Buffer.from('89504e470d0a1a0a0000','hex');
  const calls = [];
  const fetcher = async (url,type) => {
    calls.push(url);
    return type === 'text/html' ? {data:Buffer.from('<meta charset="utf-8"><title>테스트 상품</title><h1>정품브랜드</h1><p>매일 함께하는 오리지널 디자인입니다</p><script>숨긴 문구</script><img src="/one.png">'),url} : {data:image,url};
  };
  const result = await analyze({url:'https://example.com/product',brand:'정품브랜드',reference_text:'매일 함께하는 오리지널 디자인입니다',reference_image:image.toString('base64')},{fetcher});
  assert.equal(result.title,'테스트 상품');
  assert.equal(result.image_state,'동일 파일 확인');
  assert.equal(result.evidence.length,3);
  assert.equal(result.product_text.includes('숨긴 문구'),false);
  assert.deepEqual(calls,['https://example.com/product','https://example.com/one.png']);
});
test('failed image retrieval is not reported as no image match', async () => {
  const image=Buffer.from('89504e470d0a1a0a0000','hex');
  const result=await analyze({url:'https://example.com',reference_image:image.toString('base64')},{fetcher:async(url,type)=> {
    if(type==='image/')throw Error('blocked');
    return {data:Buffer.from('<img src="/a.png">'),url};
  }});
  assert.equal(result.image_state,'미검증');
  assert.match(result.warnings.join(' '),/누락/);
});
test('malformed inputs and images are rejected', async () => {
  assert.throws(()=>validateInput({url:'https://example.com'}), InputError);
  assert.throws(()=>validateInput({url:'https://example.com',brand:1}), InputError);
  await assert.rejects(analyze({url:'https://example.com',reference_image:'%%%'}), InputError);
  await assert.rejects(analyze({url:'https://example.com',reference_image:Buffer.from('not-image').toString('base64')}), InputError);
});
test('normalization and short generic phrases do not generate spurious evidence', () => {
  assert.equal(compareText('Brand','짧은 설명','BRAND 상품').length,1);
  assert.equal(compareText('','','정품').length,0);
});
test('private, reserved, mapped and metadata addresses cannot be requested', async () => {
  for(const address of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1']) assert.equal(publicAddress(address),false,address);
  for(const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(publicAddress(address),true,address);
  await assert.rejects(publicTarget('https://shop.example/',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]), InputError);
  assert.equal((await publicTarget('https://shop.example/',async()=>[{address:'8.8.8.8',family:4}])).address,'8.8.8.8');
});
test('URL credentials, non-web URLs and unusual ports are rejected', () => {
  for(const url of ['file:///etc/passwd','ftp://example.com','https://user:pass@example.com','http://example.com:8000']) assert.throws(()=>webURL(url),InputError);
});
test('HTML removes script content and resolves image URLs', () => {
  const result = extractPage(Buffer.from('<title>A</title><p>one</p><p>two</p><script>bad</script><img src="/p.png">'),'https://example.com/item');
  assert.ok(result.text.includes('one two'));
  assert.ok(!result.text.includes('bad'));
  assert.deepEqual(result.images,['https://example.com/p.png']);
});
test('function routes return no-store JSON and never expose other users history', async () => {
  const health=await handler(new Request('https://example.netlify.app/api/health'));
  assert.equal(health.status,200);
  assert.equal(health.headers.get('cache-control'),'no-store');
  assert.equal((await handler(new Request('https://example.netlify.app/api/reviews'))).status,404);
  const response=await handler(new Request('https://example.netlify.app/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com',brand:'DEMO STUDIO',demo:true})}));
  assert.equal(response.status,200);
  assert.equal((await response.json()).source,'demo');
});
test('function rejects oversized requests, wrong content type and malformed JSON', async () => {
  assert.equal((await handler(new Request('https://example.com/api/analyze',{method:'POST',body:'x'}))).status,415);
  assert.equal((await handler(new Request('https://example.com/api/analyze',{method:'POST',headers:{'content-type':'application/json','content-length':String(4*1024*1024)},body:'{}'}))).status,413);
  assert.equal((await handler(new Request('https://example.com/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:'invalid'}))).status,422);
});
