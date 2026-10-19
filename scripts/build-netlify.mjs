import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
const target = new URL('../dist/', import.meta.url);
await mkdir(new URL('static/', target), { recursive: true });
for (const file of ['style.css', 'app.js']) {
  await copyFile(new URL(`../app/static/${file}`, import.meta.url), new URL(`static/${file}`, target));
}
await copyFile(new URL('../netlify/browser/storage.js', import.meta.url), new URL('static/storage.js', target));
let html = await readFile(new URL('../app/static/index.html', import.meta.url), 'utf8');
html = html.replace('<script src="/static/app.js"></script>', '<script src="/static/storage.js"></script><script src="/static/app.js"></script>');
html = html.replace('로컬 저장 · 외부 AI 전송 없음', '이 브라우저에 기록 저장 · 외부 AI 전송 없음');
html = html.replace('LOCAL · PROTOTYPE', 'WEB · PROTOTYPE');
html = html.replace('<form id="analysis-form">', '<div class="hosting-note" role="note">웹 테스트 버전 · 분석 자료는 서버에서 처리되며 서버에 기록을 보관하지 않습니다. 검토 기록은 현재 브라우저에 저장됩니다. 공유 기기에서는 민감한 자료를 입력하지 마세요.</div><form id="analysis-form">');
await writeFile(new URL('index.html', target), html);
console.log('Built dist/: static workspace + browser-private review storage. Netlify bundles the analysis function separately.');
