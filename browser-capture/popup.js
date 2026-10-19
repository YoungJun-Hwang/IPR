const $=id=>document.getElementById(id);
let current=null;
function db(){return new Promise((resolve,reject)=>{const req=indexedDB.open('ipr-visible-capture-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('products',{keyPath:'url'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(Error('저장 공간을 열 수 없습니다.'));});}
async function records(){const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('products');const req=tx.objectStore('products').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(Error('자료를 읽지 못했습니다.'));tx.oncomplete=()=>database.close();});}
async function put(product){const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('products','readwrite');tx.objectStore('products').put(product);tx.oncomplete=()=>{database.close();resolve();};tx.onerror=()=>{database.close();reject(Error('상품 저장 실패'));};});}
async function refresh(){const all=await records();$('count').textContent=`실제 저장 자료: ${all.length}개 상품`;}
function visibleCapture(){
  if(location.hostname!=='www.coupang.com'||!/^\/vp\/products\/\d+/.test(location.pathname))throw Error('쿠팡 상품 상세 화면에서 실행해 주세요. 목록 화면이나 로그인 화면은 수집하지 않습니다.');
  const title=document.querySelector('meta[property="og:title"]')?.content||document.querySelector('h1')?.innerText||document.title;
  const image=document.querySelector('meta[property="og:image"]')?.content||document.querySelector('.prod-image img, [data-testid="product-image"] img')?.src||'';
  if(!image)throw Error('대표 상품 이미지를 확인하지 못했습니다. 로그인·캡차·접근 거절 화면이라면 정상 접근 후 다시 실행하세요.');
  let sellerName='',sellerURL='',kind='unknown',evidence='',sellerID='';const sellerIDs=new Set(),typeKinds=new Set();
  const visible=element=>element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
  const scopes=[...document.querySelectorAll('[data-seller-id], [id*="seller"], [class*="seller"], [role="dialog"]')].filter(visible);
  for(const scope of scopes){
    const id=scope.getAttribute('data-seller-id');if(id){sellerID=location.host+':seller:'+id;sellerIDs.add(sellerID);}
    const declared=scope.getAttribute('data-seller-name');if(declared)sellerName=declared;
    for(const row of scope.querySelectorAll('tr')){
      if(!visible(row))continue;const cells=row.querySelectorAll('th,td');if(cells.length<2)continue;
      const label=cells[0].innerText.trim(),value=cells[1].innerText.trim();
      if(/^(상호|상호명|판매자명|업체명)$/.test(label))sellerName=value;
      if(/^(사업자\s*(구분|유형|형태)|판매자\s*(유형|구분))$/.test(label)&&['개인사업자','개인 사업자','법인사업자','법인 사업자'].includes(value)){kind=value.startsWith('개인')?'individual':'corporation';evidence=label+' : '+value;typeKinds.add(kind);}
    }
    for(const link of scope.querySelectorAll('a[href]')){
      try{const url=new URL(link.href);if(url.hostname==='www.coupang.com'&&/\/(?:vp\/vendors|sellers?|shops)\//.test(url.pathname)){sellerURL=url.href;break;}}catch{}
    }
  }
  if(sellerIDs.size>1||typeKinds.size>1){sellerID='';sellerName='';sellerURL='';kind='unknown';evidence='복수 판매자 또는 유형 충돌: 사용자 확인 필요';}
  const clean=new URL(location.href);clean.search='';clean.hash='';for(const key of ['itemId','vendorItemId']){const value=new URL(location.href).searchParams.get(key);if(value)clean.searchParams.set(key,value);}
  return {url:clean.href,name:title.slice(0,300),category:'사용자 방문 상품',image_url:image,seller:{id:sellerID,name:sellerName,url:sellerURL,business_type:kind,type_evidence:evidence,evidence_url:clean.href,source:'visible_page'}};
}
$('read').onclick=async()=>{current=null;$('capture').disabled=true;try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id)throw Error('현재 탭을 찾을 수 없습니다.');
  const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:visibleCapture});
  if(!result?.result)throw Error('상품 정보를 읽지 못했습니다. 쿠팡 상품 화면인지 확인해 주세요.');
  current=result.result;$('name').value=current.name;$('seller-name').value=current.seller.name;$('seller-url').value=current.seller.url;$('type').value=current.seller.business_type;$('evidence').value=current.seller.type_evidence;
  $('capture').disabled=false;$('message').textContent='현재 화면에서 읽었습니다. 판매자와 유형을 확인한 뒤 저장하세요.';
}catch(error){$('message').textContent=error.message;}};
$('capture').onclick=async()=>{
  if(!current)return;
  // Optional permission is requested directly in this click, not during page load.
  const permission=chrome.permissions.request({origins:['https://*.coupangcdn.com/*']});
  $('capture').disabled=true;
  try{
    if(!await permission)throw Error('대표 사진을 저장하려면 쿠팡 이미지 호스트 접근 권한이 필요합니다.');
    const url=new URL(current.image_url);if(url.protocol!=='https:'||!url.hostname.endsWith('.coupangcdn.com')||url.username||url.password)throw Error('공개 쿠팡 CDN 대표 사진 URL을 확인하지 못했습니다. 해당 상품은 수집하지 않았습니다.');
    const kind=$('type').value,quote=$('evidence').value.trim(),profile=$('seller-url').value.trim();
    let id=current.seller.id;
    if(profile){const parsed=new URL(profile);if(parsed.hostname!=='www.coupang.com'||parsed.protocol!=='https:'||parsed.username||parsed.password||!/^\/(?:vp\/vendors|sellers?|shops)\//.test(parsed.pathname))throw Error('쿠팡의 공개 판매자 프로필 URL을 입력해 주세요. 상품 URL은 판매자 프로필이 아닙니다.');id=parsed.origin+parsed.pathname.replace(/\/+$/,'');}
    if(kind!=='unknown'&&(!quote||!id))throw Error('유형을 확정하려면 명시적인 근거 문구와 공개 판매자 식별 정보가 필요합니다. 없으면 확인 불가로 두세요.');
    const response=await fetch(url.href,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok||!response.headers.get('content-type')?.startsWith('image/'))throw Error('대표 사진 요청이 거절되었습니다. 우회하지 않고 수집을 중단합니다.');
    const reader=response.body.getReader(),parts=[];let size=0;
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2*1024*1024){await reader.cancel();throw Error('대표 사진이 2MB를 초과합니다.');}parts.push(part.value);}
    const blob=new Blob(parts,{type:response.headers.get('content-type').split(';')[0]});
    const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
    const all=await records();const other=all.filter(row=>row.url!==current.url);
    if(other.length>=50||other.reduce((sum,row)=>sum+(row.images?.[0]?.data?.length||0),0)+image.length>32*1024*1024)throw Error('50개 또는 사진 합계 24MB 한도입니다. 먼저 내려받고 저장 자료를 정리하세요.');
    const modified=kind!==current.seller.business_type||quote!==current.seller.type_evidence||profile!==current.seller.url;
    await put({...current,images:[{url:url.href,data:image}],seller:{...current.seller,id:id||'unresolved:'+current.url,name:$('seller-name').value.trim()||'판매자 확인 불가',url:profile,business_type:kind,type_evidence:quote,identity_verified:Boolean(id),source:modified?'user_entered':'visible_page'},captured:new Date().toISOString()});
    $('message').textContent='실제 상품과 대표 사진을 이 브라우저에 저장했습니다.';await refresh();
  }catch(error){$('message').textContent=error.message;}finally{$('capture').disabled=false;}
};
$('download').onclick=async()=>{try{const products=await records();if(!products.length)throw Error('저장한 실제 상품이 없습니다.');const data={schema:'ipr.capture.v1',source:'user_visible_browser',created:new Date().toISOString(),site_url:'https://www.coupang.com/',products};const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='ipr-real-coupang-capture.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){$('message').textContent=error.message;}};
$('clear').onclick=async()=>{if(!confirm('이 수집 도구에 저장한 자료만 삭제할까요? 내려받은 파일은 유지됩니다.'))return;const database=await db();const tx=database.transaction('products','readwrite');tx.objectStore('products').clear();tx.oncomplete=()=>{database.close();refresh();};};
refresh().catch(error=>{$('message').textContent=error.message;});
