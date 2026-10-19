(() => {
  const KEY = 'ipr.reviews.v1:' + location.pathname.replace(/\/[^/]*$/, '/');
  const statuses = ['검토 필요', '문제없음', '추가 확인'];
  function records() {
    try {
      const items = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(items)) throw new Error();
      return items;
    } catch {
      throw new Error('브라우저의 검토 기록을 읽을 수 없습니다. 저장소 접근 허용 여부를 확인해 주세요.');
    }
  }
  function save(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); }
    catch { throw new Error('브라우저 저장 공간이 부족하거나 저장이 차단되었습니다. 기록을 내보낸 뒤 저장 공간을 확보해 주세요.'); }
  }
  window.IPR_API = async (path, options = {}) => {
    const method = options.method || 'GET';
    if (path === '/api/reviews' && method === 'GET') return records().slice(0, 100);
    const match = path.match(/^\/api\/reviews\/(\d+)$/);
    if (match) {
      const items = records();
      const item = items.find(row => String(row.id) === match[1]);
      if (!item) throw new Error('이 브라우저에서 검토 기록을 찾을 수 없습니다.');
      if (method === 'PATCH') {
        const update = JSON.parse(options.body);
        if (!statuses.includes(update.status) || typeof update.notes !== 'string' || update.notes.length > 5000) throw new Error('검토 내용을 확인해 주세요.');
        item.status = update.status;
        item.notes = update.notes;
        save(items);
      } else if (method !== 'GET') throw new Error('지원하지 않는 요청입니다.');
      return item;
    }
    let data;
    if (window.IPR_ANALYZE_BROWSER) {
      if (path !== '/api/analyze' || method !== 'POST') throw new Error('지원하지 않는 요청입니다.');
      data = await window.IPR_ANALYZE_BROWSER(JSON.parse(options.body));
    } else {
      const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
      try { data = await response.json(); }
      catch { throw new Error('분석 서버의 응답을 읽을 수 없습니다. 잠시 후 다시 시도해 주세요.'); }
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '입력 내용을 확인해 주세요.');
    }
    if (path === '/api/analyze' && method === 'POST') {
      const items = records();
      data.id = Math.max(Date.now(), ...items.map(item => Number(item.id) + 1).filter(Number.isFinite));
      data.status = '검토 필요';
      data.notes = '';
      items.unshift(data);
      // Keep full history within a bound; never silently discard older records.
      if (items.length > 100) throw new Error('이 브라우저에 100건의 기록이 있습니다. 기존 기록을 내보내고 브라우저 저장소를 정리한 뒤 다시 분석해 주세요.');
      save(items);
    }
    return data;
  };
})();
