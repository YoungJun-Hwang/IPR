(() => {
  let report = null, files = [], timer = null, loading = false;
  const staticMode = Boolean(window.IPR_STATIC_DEMO);
  const labels = {candidate:'검토 후보',below_threshold:'기준 미달 · 정상 판정 아님',partial:'일부 이미지 미점검',unverified:'미점검'};
  async function request(path,options={}) {
    const response = await fetch(path,{...options,headers:{'Content-Type':'application/json'}});
    const data = await response.json();
    if(!response.ok) throw new Error(typeof data.detail==='string'?data.detail:'입력 자료를 확인해 주세요.');
    return data;
  }
  function renderProducts() {
    const category=$('scan-category-filter').value, state=$('scan-state-filter').value;
    const products=report.products.filter(p=>(!category||p.category===category)&&(state==='all'||(state==='unverified'?(['unverified','partial'].includes(p.state)||p.errors?.length):p.state==='candidate'))).sort((a,b)=>(b.score??-1)-(a.score??-1));
    $('scan-products').replaceChildren();
    for(const product of products) {
      const card=el('article',undefined,'card scan-product');
      const picture=el('div',undefined,'scan-picture');
      if(product.thumbnail?.startsWith('data:image/')) {
        const image=el('img');image.src=product.thumbnail;image.alt=product.name;picture.append(image);
      } else picture.append(el('span', report.demo?'샘플 이미지':'이미지 미확인'));
      card.append(picture,el('small',product.category,'scan-product-category'),el('h3',product.name));
      const status=el('div',undefined,'scan-score');
      status.append(el('span',labels[product.state]),el('strong',product.score===null?'—':`${product.score}점`));
      card.append(status);
      if(product.reference_name)card.append(el('p',`기준: ${product.reference_name}`,'scan-reference'));
      if(product.reason)card.append(el('p',product.reason,'hint'));
      if(product.errors?.length)card.append(el('p',product.errors.join(' '),'error'));
      if(!report.demo) {
        try {
          const url=new URL(product.url);
          if(['http:','https:'].includes(url.protocol)) {
            const link=el('a','원본 상품 확인 ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';card.append(link);
          }
        } catch {}
      }
      $('scan-products').append(card);
    }
    if(!products.length)$('scan-products').append(el('div',report.status==='running'||report.status==='queued'?'상품을 수집·점검하는 중입니다.':'현재 필터에서 표시할 상품이 없습니다. 전체 상품과 미점검 목록도 확인해 주세요.','card empty'));
  }
  function render(data) {
    report=data;$('scan-results').hidden=false;
    $('scan-source').textContent=data.demo?'SIMULATED REPORT · 실제 수집 없음':'CATALOG SCAN REPORT';
    $('scan-stage').textContent=data.stage;
    $('scan-site').textContent=`${data.site_url} · 기준 ${data.threshold}점 · ${data.status==='failed'?'중단됨':data.status==='complete'?'처리 완료':'진행 중'}`;
    for(const field of ['discovered','checked','candidates','unverified'])$('stat-'+field).textContent=data.counts[field];
    const selected=$('scan-category-filter').value;
    const categories=[...new Set(data.products.map(p=>p.category))];
    $('scan-category-filter').replaceChildren(el('option','전체 카테고리'));
    $('scan-category-filter').firstChild.value='';
    for(const category of categories) {const option=el('option',category);option.value=category;$('scan-category-filter').append(option);}
    $('scan-category-filter').value=categories.includes(selected)?selected:'';
    $('scan-warnings').replaceChildren(...data.warnings.map(w=>el('li',w)));
    renderProducts();
  }
  async function poll(id) {
    try {
      const data=await request(`/api/scans/${id}`);render(data);
      if(['queued','running'].includes(data.status))timer=setTimeout(()=>poll(id),1600);
      else {loading=false;$('scan-start').disabled=false;await recent();}
    } catch(error) {loading=false;$('scan-start').disabled=false;$('scan-error').textContent=error.message+' 기록 목록에서 다시 열어 상태를 확인할 수 있습니다.';}
  }
  async function recent() {
    if(staticMode)return;
    try {
      const scans=await request('/api/scans');
      $('scan-recent').replaceChildren();
      if(scans.length)$('scan-recent').append(el('h3','최근 쇼핑몰 점검'));
      for(const scan of scans.slice(0,5)) {
        const button=el('button',`${scan.site_url} · 후보 ${scan.counts.candidates}개 · ${scan.status}`,'secondary');
        button.onclick=()=>{clearTimeout(timer);poll(scan.id);};$('scan-recent').append(button);
      }
    } catch { /* Individual comparison backends may not offer catalog scans. */ }
  }
  $('scan-nav').onclick=()=>view('scan');
  $('scan-threshold').oninput=()=>{$('threshold-label').textContent=$('scan-threshold').value+'점 이상';};
  $('scan-category-filter').onchange=$('scan-state-filter').onchange=renderProducts;
  $('scan-images').onchange=async()=> {
    files=[];$('scan-reference-preview').replaceChildren();
    const selected=Array.from($('scan-images').files);
    if(selected.length>3||selected.some(f=>f.size>2*1024*1024)) {$('scan-error').textContent='이미지는 최대 3개, 각 2MB까지 등록할 수 있습니다.';$('scan-images').value='';return;}
    try {
      for(const file of selected) {
        const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
        files.push({name:file.name,image:data.split(',')[1]});
        const image=el('img');image.src=data;image.alt=file.name;$('scan-reference-preview').append(image);
      }
      $('scan-error').textContent='';
    } catch {files=[];$('scan-error').textContent='이미지 파일을 읽을 수 없습니다.';}
  };
  $('scan-form').onsubmit=async event=> {
    event.preventDefault();if(loading)return;
    $('scan-error').textContent='';
    if(staticMode){$('scan-error').textContent='현재 정적 웹사이트에서는 실제 쇼핑몰 수집을 실행할 수 없습니다. 자동 점검 샘플로 결과 화면을 확인하거나 Python 서버에서 실행해 주세요.';return;}
    if(!files.length){$('scan-error').textContent='비교할 기준 이미지가 필요합니다.';return;}
    loading=true;$('scan-start').disabled=true;clearTimeout(timer);
    try {
      const data=await request('/api/scans',{method:'POST',body:JSON.stringify({site_url:$('scan-url').value.trim(),references:files,max_products:Number($('scan-limit').value),max_categories:Number($('scan-categories').value),threshold:Number($('scan-threshold').value)})});
      render(data);poll(data.id);
    } catch(error) {loading=false;$('scan-start').disabled=false;$('scan-error').textContent=error.message;}
  };
  $('scan-demo').onclick=()=> {
    if(loading){$('scan-error').textContent='실제 점검이 진행 중입니다. 완료된 후 샘플을 열어 주세요.';return;}
    clearTimeout(timer);
    const products=[
      {name:'모노그램 캔버스 토트백',category:'가방',score:98.4,state:'candidate',reference_name:'기준 가방 디자인'},
      {name:'시그니처 패턴 숄더백',category:'가방',score:93.7,state:'candidate',reference_name:'기준 가방 디자인'},
      {name:'로고 프린트 티셔츠',category:'의류',score:90.5,state:'candidate',reference_name:'기준 그래픽'},
      {name:'베이직 니트',category:'의류',score:54.0,state:'below_threshold',reference_name:'기준 그래픽'},
      {name:'캔버스 스니커즈',category:'신발',score:48.0,state:'below_threshold',reference_name:'기준 가방 디자인'},
      {name:'이미지 확인이 필요한 파우치',category:'가방',score:null,state:'unverified',reference_name:'',errors:['샘플: 이미지 요청 실패']}
    ].map((product,index)=>({url:'https://example.com/demo/'+index,thumbnail:'',reason:'샘플 화면용 예시 점수 · 실제 이미지 분석 아님',errors:[],...product}));
    $('scan-state-filter').value='candidate';
    render({id:'demo',demo:true,created:new Date().toISOString(),site_url:'샘플 쇼핑몰 (실제 수집 없음)',status:'complete',stage:'자동 점검 결과 화면 예시',threshold:88,counts:{discovered:6,checked:6,candidates:3,unverified:1},products,warnings:['이 결과는 화면 체험을 위한 가상 자료입니다. 상품을 수집하거나 이미지를 분석하지 않았으며 점수는 예시입니다.','실제 점검에는 공개 쇼핑몰 주소, 권리 기준 이미지 및 Python 수집 서버가 필요합니다.','이미지 구조의 유사도는 침해 확률이 아닙니다.']});
    $('scan-results').scrollIntoView({behavior:'smooth'});
  };
  $('scan-export').onclick=()=> {
    if(!report)return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'}));
    const link=el('a');link.href=url;link.download=`ipr-catalog-${report.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  $('scan-hosting').hidden=!staticMode;
  if(staticMode){$('scan-start').disabled=true;$('scan-start').textContent='실제 자동 점검은 서버에서 실행';}
  recent();
})();
