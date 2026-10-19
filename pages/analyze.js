(() => {
  window.IPR_STATIC_DEMO = true;
  const normalize = value => value.replace(/\s+/gu, ' ').trim().toLowerCase();
  window.IPR_ANALYZE_BROWSER = async body => {
    if (!body.brand?.trim() && !body.reference_text?.trim() && !body.reference_image) throw new Error('브랜드명, 권리 문구, 원본 이미지 중 하나 이상을 등록해 주세요.');
    let title, text, source;
    const warnings = [];
    if (body.demo) {
      title = 'DEMO STUDIO · 시그니처 캔버스백';
      text = 'DEMO STUDIO 시그니처 캔버스백. 매일의 가벼움을 위한 오리지널 캔버스 디자인.';
      source = 'demo';
    } else {
      let url;
      try { url = new URL(body.url); } catch { throw new Error('상품 출처의 http 또는 https URL을 입력해 주세요.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('인증 정보가 없는 상품 출처의 http 또는 https URL을 입력해 주세요.');
      if (!body.manual_text?.trim()) throw new Error('GitHub Pages에서는 URL 자동 수집을 지원하지 않습니다. 상품명과 설명을 아래 입력란에 붙여넣어 주세요.');
      title = '직접 입력한 상품 자료';
      text = body.manual_text;
      source = 'manual';
      warnings.push('URL을 방문하지 않았습니다. 사용자가 입력한 상품 설명만 이 브라우저에서 비교했습니다.');
    }
    const brand = body.brand || '';
    const reference = body.reference_text || '';
    const product = normalize(text);
    const evidence = [];
    if (brand.trim() && product.includes(normalize(brand))) {
      const pos = product.indexOf(normalize(brand));
      evidence.push({kind:'브랜드명 일치', reference:brand, observed:product.slice(Math.max(0,pos-45),pos+brand.length+85)});
    }
    const matches = [...new Set(reference.split(/[\n.!?。]+/u).map(s=>s.trim()).filter(s=>normalize(s).length>=12 && product.includes(normalize(s))))].slice(0,12);
    for (const match of matches) evidence.push({kind:'문구 일치',reference:match,observed:match});
    let imageState = '미등록';
    if (body.reference_image) {
      imageState = '미검증';
      warnings.push('이 정적 데모는 상품 이미지를 가져오거나 비교하지 않습니다. 등록한 원본 이미지의 파일명만 기록하며 원본 이미지 자체는 저장하지 않습니다.');
    }
    warnings.push('일치 여부는 침해 판단이 아닙니다. 정식 판매·이용 허락·권리 범위를 별도로 확인해 주세요. 등록번호는 기록용이며 공적 등록정보 조회는 수행하지 않습니다.');
    return {created:new Date().toISOString(),status:'검토 필요',notes:'',url:body.url,title,brand,registration:body.registration||'',reference_text:reference,reference_filename:body.reference_filename||'',product_text:text,source,evidence,image_state:imageState,warnings,signal:evidence.length?'검토할 일치 항목 있음':'일치 근거 미발견'};
  };
})();
