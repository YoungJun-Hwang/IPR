(() => {
  const validURL=value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}};
  const text=(value,max=300)=>typeof value==='string'?value.slice(0,max):'';
  const hex=bytes=>Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
  const hash=async bytes=>hex(await crypto.subtle.digest('SHA-256',bytes));
  const key=url=>{const u=new URL(url),match=u.hostname==='www.coupang.com'?u.pathname.match(/\/vp\/products\/(\d+)/):null;return match?'coupang:'+match[1]:u.host+u.pathname;};
  function normalizeSeller(raw,url){
    raw=raw&&typeof raw==='object'?raw:{};
    const evidence=validURL(raw.evidence_url),quote=text(raw.type_evidence,500);
    const type=['individual','corporation'].includes(raw.business_type)&&evidence&&quote?raw.business_type:'unknown';
    const id=text(raw.id,500);
    return {id:id&&!id.startsWith('unresolved:')&&raw.identity_verified===true?id:'unresolved:'+url,name:text(raw.name,150)||'판매자 확인 불가',url:validURL(raw.url),business_type:type,type_evidence:quote,evidence_url:evidence,identity_verified:Boolean(id&&!id.startsWith('unresolved:')&&raw.identity_verified===true),source:text(raw.source,80)||'imported_file'};
  }
  function review(raw){
    if(!raw||!['unreviewed','needs_review','confirmed','no_issue'].includes(raw.status))return {status:'unreviewed',notes:'',evidence_url:''};
    const notes=text(raw.notes,5000),evidence=validURL(raw.evidence_url);
    return {status:raw.status==='confirmed'&&(!notes.trim()||!evidence)?'unreviewed':raw.status,notes,evidence_url:evidence,source:'user',updated:text(raw.updated,80)};
  }
  async function decodeImage(value){
    if(typeof value!=='string'||value.length>2800000||!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value))throw Error('해석 가능한 2MB 이하 이미지 자료가 필요합니다.');
    const [header,body]=value.split(',');const binary=atob(body),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    if(bytes.length>2*1024*1024)throw Error('이미지가 2MB를 초과합니다.');
    const image=await createImageBitmap(new Blob([bytes],{type:header.slice(5,header.indexOf(';'))}));
    try{
      if(image.width*image.height>16000000)throw Error('이미지가 1,600만 화소를 초과합니다.');
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);
      const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      const rgb=new Uint8Array(image.width*image.height*3),prefix=new TextEncoder().encode(`(${image.width}, ${image.height})`);
      let mean=0,square=0,samples=0;
      for(let i=0,j=0;i<rgba.length;i+=4,j+=3){rgb[j]=rgba[i];rgb[j+1]=rgba[i+1];rgb[j+2]=rgba[i+2];if(i%256===0){const light=(rgba[i]+rgba[i+1]+rgba[i+2])/3;mean+=light;square+=light*light;samples++;}}
      const canonical=new Uint8Array(prefix.length+rgb.length);canonical.set(prefix);canonical.set(rgb,prefix.length);
      const small=document.createElement('canvas'),ratio=Math.min(180/image.width,180/image.height,1);small.width=Math.max(1,Math.round(image.width*ratio));small.height=Math.max(1,Math.round(image.height*ratio));small.getContext('2d').drawImage(canvas,0,0,small.width,small.height);
      return {sha256:await hash(bytes),pixel_sha256:await hash(canonical),informative:samples>0&&square/samples-(mean/samples)**2>16,thumbnail:small.toDataURL('image/png')};
    }finally{image.close();}
  }
  function summarize(report){
    const sellers=new Map(),photos=new Map();
    for(const product of report.products){
      const sid=product.seller.id;
      if(!sellers.has(sid))sellers.set(sid,{...product.seller,product_count:0,image_checked_products:0,duplicate_products:0,duplicate_ratio:null,duplicate_groups:0,within_seller_duplicate_products:0});
      const seller=sellers.get(sid);
      if(seller.business_type!==product.seller.business_type){seller.business_type='unknown';seller.type_evidence='수입 자료의 같은 판매자 유형이 서로 다릅니다.';}
      seller.product_count++;seller.image_checked_products+=product.images.some(image=>image.informative);
      product.duplicate_groups=[];product.duplicate_peers=[];product.within_seller_duplicate=false;product.catalog_shared_photo=false;
      for(const image of product.images){if(!image.informative)continue;const hash=image.pixel_sha256||image.sha256;if(!photos.has(hash))photos.set(hash,new Map());photos.get(hash).set(product.url,{product,image});}
    }
    const groups=[];
    for(const [photo,items] of photos){
      const members=[...items.values()],ids=new Set(members.filter(member=>member.product.seller.identity_verified).map(member=>member.product.seller.id));
      for(const member of members)if(members.filter(other=>other.product.seller.id===member.product.seller.id).length>1)member.product.within_seller_duplicate=true;
      if(ids.size<2)continue;
      const group={id:'photo-'+photo.slice(0,20),method:'파일 또는 디코딩된 동일 픽셀',members:[]};
      for(const member of members){
        const p=member.product;if(!p.seller.identity_verified)continue;
        const peers=members.filter(other=>other.product.seller.identity_verified&&other.product.seller.id!==p.seller.id&&key(other.product.url)!==key(p.url)).map(other=>({seller_id:other.product.seller.id,seller_name:other.product.seller.name,product_url:other.product.url,image_url:other.image.url}));
        if(!peers.length){p.catalog_shared_photo=true;continue;}
        p.duplicate_groups.push(group.id);p.duplicate_peers.push(...peers);group.members.push({seller_id:p.seller.id,seller_name:p.seller.name,product_url:p.url,image_url:member.image.url});
      }
      if(group.members.length)groups.push(group);
    }
    for(const product of report.products){
      const seller=sellers.get(product.seller.id);
      if(seller.business_type!==product.seller.business_type){product.seller.business_type='unknown';product.seller.type_evidence=seller.type_evidence;}
      seller.duplicate_products+=product.duplicate_groups.length>0;seller.within_seller_duplicate_products+=product.within_seller_duplicate;
      product.state=product.duplicate_groups.length?'candidate':product.images.some(image=>image.informative)&&!product.errors.length?'below_threshold':'unverified';
      product.reason=product.duplicate_groups.length?'다른 판매자·다른 카탈로그와 동일 사진':'동일 사진 근거 미발견 · 정상 판정 아님';
    }
    for(const seller of sellers.values()){const owned=report.products.filter(product=>product.seller.id===seller.id);seller.duplicate_groups=new Set(owned.flatMap(product=>product.duplicate_groups)).size;seller.duplicate_ratio=seller.image_checked_products?Math.round(seller.duplicate_products/seller.image_checked_products*1000)/10:null;}
    report.sellers=[...sellers.values()].sort((a,b)=>b.duplicate_products-a.duplicate_products||(b.duplicate_ratio||0)-(a.duplicate_ratio||0)||b.duplicate_groups-a.duplicate_groups);
    report.duplicate_image_groups=groups;
    report.counts={discovered:Math.max(report.counts?.discovered||0,report.products.length),checked:report.products.length,candidates:report.products.filter(product=>product.state==='candidate'&&product.seller.business_type==='individual').length,unverified:report.products.filter(product=>product.state==='unverified'||product.errors.length).length};
    return report;
  }
  function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open('ipr-local-reports:'+location.pathname,1);request.onupgradeneeded=()=>request.result.createObjectStore('reports',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('브라우저 저장 공간을 열 수 없습니다.'));});}
  async function save(report){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('reports','readwrite');tx.objectStore('reports').put(report);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(Error('결과 저장에 실패했습니다. 내보내기로 파일을 보관해 주세요.'));};});}
  async function all(){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('reports');const request=tx.objectStore('reports').getAll();request.onsuccess=()=>resolve(request.result.sort((a,b)=>b.created.localeCompare(a.created)));request.onerror=()=>reject(Error('저장 결과를 읽지 못했습니다.'));tx.oncomplete=()=>db.close();});}
  async function importData(raw){
    if(!raw||!['ipr.scan.v1','ipr.capture.v1'].includes(raw.schema)||raw.demo===true||!Array.isArray(raw.products)||raw.products.length>50)throw Error('실제 수집 도구의 ipr.capture.v1 또는 실행 결과 ipr.scan.v1 JSON 파일을 선택해 주세요.');
    if(raw.schema==='ipr.scan.v1'&&raw.mode&&raw.mode!=='seller_duplicates')throw Error('이 화면은 판매자 간 사진 중복 점검 결과 파일을 지원합니다.');
    if(raw.privacy_redacted&&raw.status!=='failed')throw Error('공개 저장소의 실행 결과에는 판매자 원자료를 넣지 않았습니다. 브라우저 수집 도구나 로컬 실행으로 실제 자료 파일을 만들어 주세요.');
    if(raw.schema==='ipr.scan.v1'&&!['complete','failed'].includes(raw.status))throw Error('아직 완료되거나 실패가 확정되지 않은 실행 결과입니다.');
    const report={schema:'ipr.scan.v1',id:'local-'+crypto.randomUUID(),created:text(raw.created,80)||new Date().toISOString(),site_url:validURL(raw.site_url),mode:'seller_duplicates',status:raw.status==='failed'?'failed':'complete',stage:raw.status==='failed'?'실제 수집 실패: '+text(raw.stage,500):'실제 파일의 사진 중복 계산 완료',demo:false,local:true,execution:text(raw.execution,100)||'user_visible_browser',threshold:88,products:[],counts:{discovered:Number.isFinite(raw.counts?.discovered)?Math.min(raw.counts.discovered,100000):raw.products.length},warnings:['이 파일은 사용자가 가져온 자료입니다. 사업자 분류와 파일의 출처를 독립적으로 인증하지 않았습니다.','사진 중복은 위반 확률이 아닙니다. 같은 상품 카탈로그 안의 대표 사진 공유는 집계에서 제외합니다.']};
    if(!report.site_url)throw Error('수집 출처 URL이 없습니다.');
    const seen=new Set(),cache=new Map();
    for(const original of raw.products){
      const url=validURL(original.url);if(!url||seen.has(url))continue;seen.add(url);
      const product={url,name:text(original.name)||'상품',category:text(original.category,120)||'미분류',seller:normalizeSeller(original.seller,url),images:[],thumbnail:'',errors:[],score:null,review:review(original.review)};
      for(const image of (Array.isArray(original.images)?original.images:[]).slice(0,3)){
        const imageURL=validURL(image.url);if(!imageURL)continue;
        try{
          if(raw.schema==='ipr.capture.v1'){
            let features=cache.get(image.data);if(!features){features=await decodeImage(image.data);cache.set(image.data,features);}
            product.images.push({url:imageURL,sha256:features.sha256,pixel_sha256:features.pixel_sha256,informative:features.informative});if(!product.thumbnail)product.thumbnail=features.thumbnail;
          }else{
            const sha=text(image.sha256,64),pixels=text(image.pixel_sha256,64);if(!/^[a-f0-9]{64}$/.test(sha)||pixels&&!/^[a-f0-9]{64}$/.test(pixels))continue;
            product.images.push({url:imageURL,sha256:sha,pixel_sha256:pixels,informative:image.informative===true});
          }
        }catch{product.errors.push('이미지 자료를 읽지 못했습니다.');}
      }
      if(raw.schema==='ipr.scan.v1'&&typeof original.thumbnail==='string'&&original.thumbnail.length<500000&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(original.thumbnail))product.thumbnail=original.thumbnail;
      if(!product.images.length)product.errors.push('실제 비교 가능한 이미지 자료 없음');
      if(Array.isArray(original.errors))product.errors.push(...original.errors.filter(e=>typeof e==='string').slice(0,5).map(e=>e.slice(0,300)));
      report.products.push(product);
    }
    if(!report.products.length&&report.status!=='failed')throw Error('실제 상품이 없는 완료 자료입니다. 결과를 만들지 않았습니다.');
    summarize(report);
    if(raw.schema==='ipr.capture.v1'&&!report.products.some(product=>product.images.some(image=>image.informative))){report.status='failed';report.stage='실제 상품은 읽었지만 비교 가능한 이미지가 없어 중복을 분석하지 못했습니다.';}
    await save(report);return report;
  }
  window.IPR_LOCAL_REPORTS={save,all,importData,summarize};
})();
