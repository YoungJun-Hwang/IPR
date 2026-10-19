const $ = id => document.getElementById(id);
let current = null;
let selectedImage = '';
let pending = false;
async function api(path, options = {}) {
  if (window.IPR_API) return window.IPR_API(path, options);
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '입력 내용을 확인해 주세요.');
  return value;
}
function view(name) {
  for (const v of ['new', 'history', 'result']) $(v + '-view').hidden = v !== name;
  $('new-nav').classList.toggle('active', name !== 'history');
  $('history-nav').classList.toggle('active', name === 'history');
  $('breadcrumb').textContent = ({new:'새 분석', history:'검토 기록', result:'분석 결과'})[name];
  window.scrollTo(0, 0);
}
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function result(data) {
  current = data;
  $('result-title').textContent = data.title;
  $('result-meta').textContent = `#${data.id} · ${new Date(data.created).toLocaleString('ko-KR')} · ${data.source === 'demo' ? '샘플 자료 (실제 상품 아님)' : data.source === 'manual' ? '직접 입력 자료' : '공개 페이지 분석'}`;
  $('signal').textContent = data.signal;
  $('evidence-count').textContent = `${data.evidence.length}건`;
  $('source-info').replaceChildren(el('div', `상품 출처: ${data.source === 'demo' ? '샘플 데이터' : data.url}`), el('div', `브랜드: ${data.brand || '미입력'} · 등록번호: ${data.registration || '미입력'} · 이미지: ${data.image_state}`));
  $('evidence-list').replaceChildren();
  for (const evidence of data.evidence) {
    const block = el('div', undefined, 'evidence');
    block.append(el('h3', evidence.kind));
    const grid = el('div', undefined, 'evidence-grid');
    for (const [label, text] of [['등록한 권리 자료', evidence.reference], ['상품에서 확인한 내용', evidence.observed]]) {
      const cell = el('div');
      cell.append(el('small', label), el('span', text));
      grid.append(cell);
    }
    block.append(grid); $('evidence-list').append(block);
  }
  if (!data.evidence.length) $('evidence-list').append(el('p', '입력한 자료에서 일치 근거를 찾지 못했습니다. 비침해를 의미하지 않으며, 자료 누락과 분석 범위를 확인해 주세요.', 'empty'));
  $('warnings').replaceChildren(...data.warnings.map(w => el('li', w)));
  $('status').value = data.status;
  $('notes').value = data.notes;
  $('save-message').textContent = '';
  view('result');
}
async function refreshHistory(show = false) {
  const records = await api('/api/reviews');
  $('history-count').textContent = records.length;
  $('history-list').replaceChildren();
  for (const record of records) {
    const button = el('button', undefined, 'history-item');
    const detail = el('div');
    detail.append(el('strong', record.title), el('small', `${new Date(record.created).toLocaleString('ko-KR')} · ${record.source === 'demo' ? '샘플' : record.brand || '권리 자료'} · 근거 ${record.evidence.length}건`));
    button.append(detail, el('span', record.status, 'badge'));
    button.onclick = () => result(record);
    $('history-list').append(button);
  }
  if (!records.length) $('history-list').append(el('div', '아직 검토 기록이 없습니다. 새 분석을 시작해 보세요.', 'card empty'));
  if (show) view('history');
}
async function runAnalysis(demo = false) {
  if (pending) return;
  pending = true;
  $('form-error').textContent = '';
  $('analyze').disabled = true;
  $('demo').disabled = true;
  $('analyze').textContent = '자료를 비교하고 있습니다…';
  try {
    const data = demo ? {url:'https://example.com/demo-product', brand:'DEMO STUDIO', reference_text:'매일의 가벼움을 위한 오리지널 캔버스 디자인', demo:true} : {
      url:$('url').value.trim(), brand:$('brand').value.trim(), registration:$('registration').value.trim(), reference_text:$('reference').value, reference_image:selectedImage,
      reference_filename:$('image').files[0]?.name || '', manual_text:$('manual').value
    };
    const report = await api('/api/analyze', {method:'POST', body:JSON.stringify(data)});
    result(report);
    refreshHistory().catch(() => {});
  } catch (error) { $('form-error').textContent = error.message; }
  finally { pending = false; $('analyze').disabled = false; $('demo').disabled = false; $('analyze').textContent = '비교 분석 시작 →'; }
}
$('analysis-form').onsubmit = event => {event.preventDefault(); runAnalysis();};
$('demo').onclick = () => runAnalysis(true);
$('image').onchange = async () => {
  selectedImage = '';
  const file = $('image').files[0];
  $('file-label').textContent = '이미지를 선택해 업로드';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { $('form-error').textContent = '이미지는 2MB 이하여야 합니다.'; $('image').value = ''; return; }
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 8192) binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
    selectedImage = btoa(binary);
    $('file-label').textContent = file.name;
    $('form-error').textContent = '';
  } catch { $('form-error').textContent = '이미지를 읽을 수 없습니다.'; }
};
$('new-nav').onclick = $('back').onclick = () => view('new');
$('history-nav').onclick = () => refreshHistory(true).catch(error => { $('form-error').textContent = error.message; view('new'); });
$('save-review').onclick = async () => {
  $('save-review').disabled = true;
  try {
    current = await api(`/api/reviews/${current.id}`, {method:'PATCH', body:JSON.stringify({status:$('status').value, notes:$('notes').value})});
    $('save-message').textContent = '검토 결과가 저장되었습니다.';
    refreshHistory().catch(() => {});
  } catch(error) { $('save-message').textContent = error.message; }
  finally { $('save-review').disabled = false; }
};
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], {type:'application/json;charset=utf-8'}));
  const link = el('a'); link.href = url; link.download = `ipr-review-${current.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
refreshHistory().catch(() => { $('form-error').textContent = '검토 기록을 불러오지 못했습니다. 서버 상태를 확인해 주세요.'; });
