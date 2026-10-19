import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const analyzeSource = await readFile(new URL('../../pages/analyze.js',import.meta.url),'utf8');
const storageSource = await readFile(new URL('../../netlify/browser/storage.js',import.meta.url),'utf8');
function browser(path='/IPR/',store=new Map()) {
  const window={};
  const context=vm.createContext({window, URL, Date, location:{pathname:path}, localStorage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value)}, fetch:()=>{throw Error('unexpected network request');}});
  vm.runInContext(analyzeSource,context);
  vm.runInContext(storageSource,context);
  return window;
}
const demo={url:'https://example.com/product',brand:'DEMO STUDIO',reference_text:'매일의 가벼움을 위한 오리지널 캔버스 디자인',demo:true};
test('sample analysis generates two evidence items without network requests',async()=> {
  const result=await browser().IPR_ANALYZE_BROWSER(demo);
  assert.equal(result.evidence.length,2);
  assert.equal(result.source,'demo');
});
test('manual comparison normalizes whitespace and reports no-match accurately',async()=> {
  const app=browser();
  const found=await app.IPR_ANALYZE_BROWSER({url:'https://example.com/product',brand:'브랜드A',reference_text:'함께하는 일상을 위한 오리지널 디자인',manual_text:'브랜드A 상품. 함께하는 일상을 위한   오리지널 디자인'});
  assert.equal(found.evidence.length,2);
  const missing=await app.IPR_ANALYZE_BROWSER({url:'https://example.com/product',brand:'브랜드A',manual_text:'다른 상품 설명'});
  assert.equal(missing.signal,'일치 근거 미발견');
});
test('URL-only and invalid sources explain supported workflow',async()=> {
  const app=browser();
  await assert.rejects(app.IPR_ANALYZE_BROWSER({url:'https://example.com',brand:'test'}),/상품명과 설명/);
  await assert.rejects(app.IPR_ANALYZE_BROWSER({url:'file:///etc/passwd',brand:'test',manual_text:'text'}),/http/);
  await assert.rejects(app.IPR_ANALYZE_BROWSER({url:'https://example.com',manual_text:'text'}),/하나 이상/);
});
test('image registration never claims a comparison happened',async()=> {
  const result=await browser().IPR_ANALYZE_BROWSER({...demo,reference_image:'some-image',reference_filename:'sample.png'});
  assert.equal(result.image_state,'미검증');
  assert.match(result.warnings.join(' '),/비교하지 않습니다/);
  assert.equal('reference_image' in result,false);
});
test('save, update and reload persist records while other project paths are isolated',async()=> {
  const store=new Map();
  const first=browser('/IPR/',store);
  const report=await first.IPR_API('/api/analyze',{method:'POST',body:JSON.stringify(demo)});
  await first.IPR_API(`/api/reviews/${report.id}`,{method:'PATCH',body:JSON.stringify({status:'추가 확인',notes:'정식 판매 확인'})});
  const reloaded=browser('/IPR/index.html',store);
  assert.equal((await reloaded.IPR_API('/api/reviews'))[0].notes,'정식 판매 확인');
  assert.equal((await browser('/other-project/',store).IPR_API('/api/reviews')).length,0);
  await assert.rejects(reloaded.IPR_API(`/api/reviews/${report.id}`,{method:'PATCH',body:JSON.stringify({status:'wrong',notes:''})}),/검토 내용/);
});
test('corrupt or unavailable storage reports an error instead of replacing data',async()=> {
  const store=new Map([['ipr.reviews.v1:/IPR/','broken-json']]);
  await assert.rejects(browser('/IPR/',store).IPR_API('/api/reviews'),/읽을 수 없습니다/);
  assert.equal(store.get('ipr.reviews.v1:/IPR/'),'broken-json');
});
