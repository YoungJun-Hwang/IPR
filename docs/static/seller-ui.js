(() => {
  const selected=new Set();let activeId=null;
  const types={individual:'개인사업자',corporation:'법인사업자',unknown:'확인 불가'};
  const reviews={unreviewed:'미검토',needs_review:'추가 검토',confirmed:'사용자 확인 완료',no_issue:'사용자 문제없음'};
  const get=()=>window.IPR_SCANNER.getReport();
  function updateMode() {
    const reference=$('scan-mode').value==='reference';
    $('scan-reference-card').hidden=!reference;
    $('scan-images').required=reference;
    $('seller-method-note').hidden=reference;
  }
  $('scan-mode').onchange=updateMode;updateMode();
  function sellerType(product,report) {
    return report.sellers?.find(seller=>seller.id===product.seller?.id)?.business_type||product.seller?.business_type||'unknown';
  }
  window.IPR_SELLER_FILTER=(product,report)=> {
    if(report.mode!=='seller_duplicates')return true;
    const type=$('seller-type-filter').value;
    return (type==='all'||sellerType(product,report)===type)&&(!$('seller-select').value||product.seller?.id===$('seller-select').value);
  };
  function count() {$('selected-count').textContent=`${selected.size}개 선택`;}
  window.IPR_DECORATE_PRODUCT=(card,product,report)=> {
    if(report.mode!=='seller_duplicates')return;
    const label=el('label',undefined,'product-checkbox');
    const box=el('input');box.type='checkbox';box.checked=selected.has(product.url);box.setAttribute('aria-label',product.name+' 선택');
    box.onchange=()=>{box.checked?selected.add(product.url):selected.delete(product.url);count();};
    label.append(box,el('span','정리할 상품 선택'));card.prepend(label);
    const seller=product.seller||{};
    card.append(el('p',`${seller.name||'판매자 확인 불가'} · ${types[sellerType(product,report)]}`,'seller-name'));
    if(product.catalog_shared_photo)card.append(el('p','동일 카탈로그 사진 공유 · 우선 집계 제외','hint'));
    const peers=[...new Set((product.duplicate_peers||[]).map(peer=>peer.seller_name))];
    if(peers.length)card.append(el('p','동일 사진 판매자: '+peers.join(', '),'hint'));
    card.append(el('p',reviews[product.review?.status||'unreviewed'],'review-state'));
    if(product.review?.notes)card.append(el('p',product.review.notes,'hint'));
  };
  window.IPR_RENDER_SELLERS=report=> {
    const enabled=report.mode==='seller_duplicates';
    $('seller-ranking').hidden=$('bulk-review').hidden=!enabled;
    if(activeId!==report.id){selected.clear();activeId=report.id;count();$('bulk-message').textContent='';}
    $('stat-candidates').parentElement.querySelector('span').textContent=enabled?'개인사업자 중복 상품':'검토 후보';
    if(!enabled)return;
    const old=$('seller-select').value;
    const type=$('seller-type-filter').value;
    const sellers=(report.sellers||[]).filter(seller=>type==='all'||seller.business_type===type);
    $('seller-select').replaceChildren(el('option','모든 판매자'));$('seller-select').firstChild.value='';
    for(const seller of sellers){const option=el('option',seller.name);option.value=seller.id;$('seller-select').append(option);}
    $('seller-select').value=sellers.some(seller=>seller.id===old)?old:'';
    $('seller-cards').replaceChildren();
    for(const [index,seller] of sellers.entries()) {
      const card=el('article',undefined,'card seller-card');
      card.append(el('small',`${index+1} · ${types[seller.business_type]}`),el('h3',seller.name),el('strong',`중복 상품 ${seller.duplicate_products}개`));
      card.append(el('p',`이미지 확보 ${seller.image_checked_products}/${seller.product_count}개 · 중복 비율 ${seller.duplicate_ratio===null?'미산정':seller.duplicate_ratio+'%'} · 사진 묶음 ${seller.duplicate_groups}개`,'hint'));
      card.append(el('p',`같은 판매자 내 사진 재사용 상품 ${seller.within_seller_duplicate_products||0}개 (판매자 간 중복과 별도 집계)`,'hint'));
      card.append(el('p',seller.type_evidence||'공개 사업자 유형 근거 없음','hint'));
      if(!seller.identity_verified)card.append(el('p','판매자 식별 불가 · 다른 판매자와 중복 집계 제외','hint'));
      if(!report.demo&&seller.evidence_url){try{const source=new URL(seller.evidence_url);if(['http:','https:'].includes(source.protocol)&&!source.username&&!source.password){const link=el('a','사업자 구분 출처 ↗');link.href=source.href;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}}catch{}}
      const button=el('button','이 판매자 상품 보기','secondary');button.onclick=()=>{$('seller-select').value=seller.id;$('scan-state-filter').value='all';$('scan-category-filter').value='';window.IPR_SCANNER.renderProducts();};card.append(button);
      $('seller-cards').append(card);
    }
    if(!sellers.length)$('seller-cards').append(el('p','현재 유형으로 확인된 판매자가 없습니다. 확인 불가 목록과 수집 오류를 확인해 주세요.','empty'));
    $('stat-candidates').parentElement.querySelector('span').textContent='개인사업자 중복 상품';
    $('scan-site').textContent=report.site_url+' · 판매자 간 동일 사진 점검 · '+report.status;
  };
  $('seller-type-filter').onchange=()=>{window.IPR_RENDER_SELLERS(get());window.IPR_SCANNER.renderProducts();};
  $('seller-select').onchange=()=>window.IPR_SCANNER.renderProducts();
  $('select-visible').onclick=()=> {
    const report=get(),category=$('scan-category-filter').value,state=$('scan-state-filter').value;
    for(const product of report.products)if(window.IPR_SELLER_FILTER(product,report)&&(!category||product.category===category)&&(state==='all'||state==='candidate'&&product.state==='candidate'||state==='unverified'&&(product.state==='unverified'||product.errors?.length)))selected.add(product.url);
    window.IPR_SCANNER.renderProducts();count();
  };
  $('clear-selection').onclick=()=>{selected.clear();window.IPR_SCANNER.renderProducts();count();};
  $('bulk-save').onclick=async()=> {
    const report=get();
    $('bulk-message').textContent='';
    if(!selected.size){$('bulk-message').textContent='정리할 상품을 선택해 주세요.';return;}
    const update={product_urls:[...selected],status:$('bulk-status').value,notes:$('bulk-notes').value,evidence_url:$('bulk-evidence').value.trim()};
    if(update.status==='confirmed'&&(!update.notes.trim()||!update.evidence_url)){$('bulk-message').textContent='확인 완료에는 확인 내용과 근거 URL이 필요합니다.';return;}
    if(update.evidence_url){try{const u=new URL(update.evidence_url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error();}catch{$('bulk-message').textContent='유효한 http 또는 https 근거 URL을 입력해 주세요.';return;}}
    $('bulk-save').disabled=true;
    try {
      let result;
      if(report.demo) {
        result=structuredClone(report);
        for(const product of result.products)if(selected.has(product.url))product.review={...update,product_urls:undefined,source:'user',updated:new Date().toISOString()};
        localStorage.setItem('ipr.seller-demo.v1:'+location.pathname,JSON.stringify(result));
      } else {
        const response=await fetch(`/api/scans/${report.id}/reviews`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(update)});
        result=await response.json();if(!response.ok)throw Error(typeof result.detail==='string'?result.detail:'저장에 실패했습니다.');
      }
      window.IPR_SCANNER.render(result);$('bulk-message').textContent=report.demo?'샘플 검토 기록이 이 브라우저에 저장되었습니다.':'선택 상품의 검토 기록을 저장했습니다.';
    } catch(error){$('bulk-message').textContent=error.message;}
    finally{$('bulk-save').disabled=false;}
  };
  function bundle() {
    const report=get(),groups=new Map();
    for(const product of report.products)if(product.review?.status==='confirmed') {
      const seller=product.seller||{};const key=seller.id||product.url;
      if(!groups.has(key))groups.set(key,{seller,products:[]});groups.get(key).products.push(product);
    }
    return {scan_id:report.id,demo:Boolean(report.demo),site_url:report.site_url,confirmation_source:'사용자가 확인 내용과 근거를 등록한 기록입니다. 프로그램의 법적 판정이 아닙니다.',product_count:[...groups.values()].reduce((sum,group)=>sum+group.products.length,0),sellers:[...groups.values()]};
  }
  function download(data,type,name){const url=URL.createObjectURL(new Blob([data],{type}));const link=el('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('confirmed-json').onclick=()=>{const data=bundle();if(!data.product_count){$('bulk-message').textContent='확인 완료로 기록한 상품이 없습니다.';return;}download(JSON.stringify(data,null,2),'application/json;charset=utf-8',`ipr-confirmed-${data.scan_id}.json`);};
  $('confirmed-csv').onclick=()=> {
    const data=bundle();if(!data.product_count){$('bulk-message').textContent='확인 완료로 기록한 상품이 없습니다.';return;}
    const rows=[['자료 구분','판매자','사업자 유형','유형 근거','유형 출처','상품','카테고리','상품 URL','이미지 URL','동일 사진 다른 상품 URL','사진 묶음 ID','검토 상태','확인 내용','근거 URL','기록 일시']];
    for(const group of data.sellers)for(const product of group.products)rows.push([data.demo?'가상 샘플':'수집 자료',group.seller.name,types[group.seller.business_type],group.seller.type_evidence,group.seller.evidence_url,product.name,product.category,product.url,(product.images||[]).map(image=>image.url).join('\n'),(product.duplicate_peers||[]).map(peer=>peer.product_url).join('\n'),(product.duplicate_groups||[]).join(', '),'사용자 확인 완료',product.review.notes,product.review.evidence_url,product.review.updated]);
    const cell=value=>{let text=String(value??'');if(/^[=+\-@\t\r]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
    download('\ufeff'+rows.map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8',`ipr-confirmed-${data.scan_id}.csv`);
  };
  window.IPR_SELLER_DEMO=()=> {
    const key='ipr.seller-demo.v1:'+location.pathname;
    try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved?.demo&&saved.mode==='seller_duplicates')return saved;}catch{}
    const sellers=[
      {id:'A',name:'샘플 판매자 A',business_type:'individual',product_count:3,image_checked_products:3,duplicate_products:2,duplicate_ratio:66.7,duplicate_groups:2,within_seller_duplicate_products:0},
      {id:'C',name:'샘플 법인 C',business_type:'corporation',product_count:1,image_checked_products:1,duplicate_products:1,duplicate_ratio:100,duplicate_groups:1,within_seller_duplicate_products:0},
      {id:'D',name:'샘플 유형 미확인 D',business_type:'unknown',product_count:1,image_checked_products:1,duplicate_products:1,duplicate_ratio:100,duplicate_groups:1,within_seller_duplicate_products:0},
      {id:'B',name:'샘플 판매자 B',business_type:'individual',product_count:2,image_checked_products:2,duplicate_products:1,duplicate_ratio:50,duplicate_groups:1,within_seller_duplicate_products:0}
    ].map(seller=>({...seller,identity_verified:true,type_evidence:seller.business_type==='unknown'?'샘플: 유형 근거 없음':'가상 자료의 사업자 구분',evidence_url:'https://example.com/demo-seller/'+seller.id}));
    const products=[['A','샘플 캔버스백','가방','photo1'],['A','샘플 숄더백','가방','photo2'],['A','샘플 양말','의류',''],['B','샘플 토트백','가방','photo1'],['B','샘플 티셔츠','의류',''],['C','샘플 파우치','가방','photo2'],['D','샘플 가방','가방','photo1']].map(([sid,name,category,photo],index)=>({url:'https://example.com/demo-product/'+index,name,category,seller:sellers.find(seller=>seller.id===sid),thumbnail:'',images:[],state:photo?'candidate':'below_threshold',score:null,reason:photo?'샘플: 다른 판매자와 동일 사진':'샘플: 중복 사진 없음',errors:[],duplicate_groups:photo?[photo]:[],duplicate_peers:photo?[{seller_name:'다른 가상 판매자',seller_id:'sample-peer',product_url:'https://example.com/sample-peer'}]:[],review:{status:'unreviewed',notes:'',evidence_url:''}}));
    return {id:'seller-demo',demo:true,mode:'seller_duplicates',created:new Date().toISOString(),site_url:'쿠팡형 판매자 목록 예시 · 실제 쿠팡 수집 아님',status:'complete',stage:'개인사업자 판매자별 정리 예시',threshold:88,counts:{discovered:7,checked:7,candidates:3,unverified:0},seller_counts:{all:4,individual:2,corporation:1,unknown:1},sellers,products,duplicate_image_groups:[],warnings:['가상의 판매자·제품·중복 수치입니다. 쿠팡에 실제로 접속하거나 판매자를 판정하지 않았습니다.','개인사업자 여부나 사진 중복은 위반 확률이 아닙니다. 쿠팡 동일 상품 카탈로그의 대표 사진 공유는 우선 집계에서 제외합니다.','확인 완료로 기록하려면 사용자가 확인 내용과 근거 URL을 입력해야 합니다.']};
  };
})();
