(() => {
  async function history(){
    try{
      const reports=await window.IPR_LOCAL_REPORTS.all();$('local-report-history').replaceChildren();
      for(const report of reports.slice(0,8)){
        const button=el('button',`${new Date(report.created).toLocaleString('ko-KR')} · 실제 파일 ${report.counts.checked}개 · ${report.status==='failed'?'수집/분석 실패':'중복 '+report.counts.candidates+'개'}`,'secondary');
        button.onclick=()=>open(report);$('local-report-history').append(button);
      }
    }catch(error){$('real-report-message').textContent=error.message;}
  }
  function open(report){
    $('scan-state-filter').value=report.counts.candidates?'candidate':'all';
    $('seller-type-filter').value=report.sellers.some(seller=>seller.business_type==='individual')?'individual':'all';
    $('seller-select').value='';$('scan-category-filter').value='';
    view('scan');window.IPR_SCANNER.render(report);$('scan-results').scrollIntoView({behavior:'smooth'});
  }
  $('real-report-file').onchange=async()=>{
    const file=$('real-report-file').files[0];if(!file)return;
    if(file.size>48*1024*1024){$('real-report-message').textContent='파일은 48MB 이하여야 합니다.';return;}
    $('real-report-message').textContent='실제 파일과 이미지 자료를 처리하고 있습니다…';
    $('real-report-file').disabled=true;
    try{
      const raw=JSON.parse((await file.text()).replace(/^\uFEFF/,''));
      const report=await window.IPR_LOCAL_REPORTS.importData(raw);
      open(report);await history();
      $('real-report-message').textContent=report.status==='failed'?'실제 실행의 실패 결과를 열었습니다. 샘플로 대체하지 않았습니다.':'실제 자료 '+report.counts.checked+'개를 처리했습니다. 사업자 정보 출처와 수집 범위를 함께 확인해 주세요.';
    }catch(error){$('real-report-message').textContent=error instanceof SyntaxError?'올바른 JSON 파일이 아닙니다.':error.message;}
    finally{$('real-report-file').disabled=false;$('real-report-file').value='';}
  };
  history();
})();
