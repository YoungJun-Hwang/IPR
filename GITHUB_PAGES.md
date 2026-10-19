# GitHub Pages 시연 버전

이 버전은 Python·Netlify 서버 없이 GitHub Pages에서 동작합니다. 샘플 분석과 직접 입력한 상품 설명의 브랜드명·문구 비교, 검토 상태·의견 저장 및 JSON 내보내기를 지원합니다. 모든 비교와 기록 저장은 브라우저에서 이루어지며 자료를 API로 전송하지 않습니다.

## 공개 웹사이트 배포

저장소: `YoungJun-Hwang/IPR`

`main`에 푸시하면 `.github/workflows/pages.yml`이 정적 데모를 테스트·빌드한 뒤 Pages 배포를 시도합니다. `configure-pages`의 자동 활성화가 저장소 권한이나 GitHub 요금제 때문에 실패하는 경우 저장소 관리자가 다음 설정을 적용해야 합니다.

1. GitHub 저장소의 **Settings → Pages**로 이동합니다.
2. **Build and deployment → Source**에서 **GitHub Actions**를 선택합니다.
3. **Actions → Deploy GitHub Pages demo → Run workflow**로 다시 실행합니다.
4. 성공한 배포의 `github-pages` 환경에 표시되는 실제 주소를 엽니다.

별도 GitHub Actions 사용이 어렵다면 Pages Source를 **Deploy from a branch**로 선택하고 **main /docs**를 저장해도 됩니다. `docs/`에는 완성된 정적 파일이 포함되어 있습니다. 이후 이 방식을 계속 사용할 경우 불필요한 Actions 배포 워크플로는 비활성화합니다.

개인 토큰을 사이트 코드나 GitHub Pages 환경 변수에 등록할 필요는 없습니다. GitHub Pages를 지원하는 저장소 공개 범위·요금제와 저장소 관리자 권한이 필요합니다. 이 작업은 저장소 공개 범위를 변경하지 않습니다.

## 실제 파일 분석

Pages에서 실제 `ipr.capture.v1` 자료와 `ipr.scan.v1` 실행 결과를 불러와 분석·검토할 수 있습니다. 샘플 전용이라는 이전 제약을 실제 자료 파일 경로로 보완했습니다. [REAL_USE.md](REAL_USE.md)의 수집 도구·GitHub 실행·저장 안내를 참고하세요.

## 판매자별 우선 검토 화면

새 기본 모드는 개인사업자 판매자의 동일 사진 재사용 우선 정리입니다. Pages의 샘플은 가상 판매자 자료이며 실제 쿠팡 수집이 아닙니다. 확인 내용·근거 URL을 등록하면 샘플 상품들을 일괄 기록하고 확인 완료만 JSON·CSV로 내보낼 수 있습니다. 실제 자료 수집과 분류 기준은 [SELLER_SCREENING.md](SELLER_SCREENING.md)를 참고하세요.

## 쇼핑몰 점검 화면

새 기본 화면은 카테고리별 쇼핑몰 자동 점검입니다. Pages의 `자동 점검 샘플 보기`는 가상 상품·예시 점수로 목록·필터·JSON 내보내기를 보여줍니다. 실제 수집·이미지 분석은 실행하지 않습니다. 실데이터 점검과 알고리즘 범위는 [CATALOG_SCANNING.md](CATALOG_SCANNING.md)를 참고하세요.

## 사용

- **샘플로 둘러보기**: 가상 브랜드의 일치 근거 2건을 표시하고 검토 기록으로 저장합니다.
- **직접 입력**: 상품 출처 URL, 상품명·설명, 브랜드명·원본 문구를 입력한 뒤 비교합니다. URL은 출처 기록용이며 방문하거나 수집하지 않습니다.
- **검토 기록**: 상태와 의견을 저장하고 JSON 파일로 내보냅니다. 브라우저 저장 용량과 최대 100건 제한이 적용됩니다.

상품 URL 자동 수집, 이미지 비교, PDF 해석과 침해 여부 판단은 이 정적 데모에서 제공하지 않습니다. 이미지 파일을 선택하면 파일명만 기록되며 비교 결과는 `미검증`으로 표시됩니다. 기존 Python/Netlify 버전은 별도로 유지됩니다.

기록은 현재 브라우저·사이트 경로에 저장됩니다. 다른 기기나 브라우저로 동기화되지 않습니다. 공유 기기에서는 민감한 자료를 입력하지 말고 중요한 기록은 내보내세요. GitHub 등 호스팅 제공자에는 정적 파일에 대한 일반 접근 로그가 남을 수 있습니다.

## 수정과 로컬 검증

```bash
node --test tests/pages/*.test.mjs
node scripts/build-pages.mjs
```

Node.js 이외의 설치나 `npm ci`가 필요하지 않습니다. 생성된 `docs/`를 함께 커밋합니다. 프로젝트 사이트의 하위 경로를 지원하도록 모든 정적 파일 링크는 상대 경로를 사용합니다. GitHub Actions가 저장소의 기본 권한 정책에 의해 차단되면 관리자가 Actions 실행과 Pages 배포를 허용해야 합니다.
