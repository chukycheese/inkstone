# Linear Tickets

> Linear MCP(`https://mcp.linear.app/mcp`)로 생성 완료. 팀 `chukycheese`의 라벨은 `Bug`/`Feature`/`Improvement`만 존재.

## 1) CKCZ-16 · [Fix] Medium 앱 공유 시 `Text failed: PDF → URL` 변환 에러
- URL: https://linear.app/chukycheese/issue/CKCZ-16
- 상태: Backlog · 라벨: `Bug` · 우선순위: High

**설명:**
- 사파리 공유 → `Chuky Simple` 실행 시 Medium 앱이 `Safari WebPage` 타입으로 공유 → `Shortcut Input`을 바로 `url`로 쓰면 `PDF → URL` 변환 실패로 `Text` 액션에서 터짐 (`lnkd.in`도 동일하게 jina 403)
- `r.jina.ai` 자체는 Medium HTML은 정상 긁음

**재현:**
1. Medium 앱에서 글 공유 → `Chuky Simple`
2. `Text failed because Shortcuts couldn't convert from PDF to URL.` 알림

**수정안:**
- 단축어에 `URL` 액션 1개 추가: 입력 `단축어 입력` → 출력 `URL` 변수
- 다음 `URL의 내용 가져오기`의 `url` 값을 `URL` 변수로 교체 (강제 URL 추출)
- 서버는 이미 `src/worker/routes/capture.ts:39`에서 `r.jina.ai`로 처리하므로 단축어에서 jina 호출 제거, `POST /api/capture {url, title, folderId}`만 유지

**AC:**
- [ ] Medium / LinkedIn / X 공유 모두 `200 ok`로 `00 Inbox`에 저장
- [ ] `Authorization: Bearer ink_...` 키 교체 없이도 401 안 나게 테스트

**우선순위:** Medium / **라벨:** `bug`, `mobile`

---

## 2) CKCZ-17 · [Feature] Inbox 자동 enrich 파이프라인 (서버 jina + 크론)
- URL: https://linear.app/chukycheese/issue/CKCZ-17
- 상태: Backlog · 라벨: `Feature` · 우선순위: Medium

**설명:**
- 08-25~28에 `00 Inbox`에 URL-only 20개가 쌓였고, 수동으로 `r.jina.ai` 긁어 `> TL;DR` + 전문으로 덮고 `02 Papers`/`05 Resources`로 이동해야 했음
- 현재 `POST /api/capture`는 배포 후(`fd459323`) 서버에서 `r.jina.ai` 자동 enrich 하므로 신규 공유는 자동, 기존 20개는 백필 필요했음

**작업:**
- 서버: `src/worker/routes/capture.ts:39` PDF 분기(`arxiv.org/pdf` → `/html` 변환) + 오디오 `Whisper` 분기 유지, 무료 티어 내 동작 확인
- 클라이언트: `Chuky Simple`을 `URL` → `POST /api/capture` 2액션으로 단순화 (jina/변수 제거)
- 배치: 남은 `Inbox` 6개는 `fixupx`/`html` 변환으로 처리, `01m0xn6fqj...` 중복 1개 휴지통 처리 완료 — 향후 크론으로 `Inbox` 폴링 enrich 자동화 검토

**AC:**
- [ ] 신규 공유 1건 공유 → `00 Inbox`에 ` - 출처`/`- 수집일` + `> TL;DR` + 전문으로 자동 생성
- [ ] arXiv `pdf` 링크도 `html`로 변환되어 전문 들어옴
- [ ] 중복 URL은 1개만 남고 나머지 휴지통

**우선순위:** Medium / **라벨:** `enhancement`, `knowledge-base`

---

## 3) CKCZ-18 · [Bug] arXiv HTML 수집 시 SVG-only 깨짐 → ar5iv 폴백
- URL: https://linear.app/chukycheese/issue/CKCZ-18
- 상태: **Done** (`3d95b6a2` 배포) · 라벨: `Bug`

**작업:**
- `src/worker/routes/capture.ts` — `looksLikeBrokenArxiv`(본문 <500자 / 첫 줄 `.svg` / `Report GitHub Issue`·`Content selection saved` 패널) + `ar5ivRewrite`(`arxiv.org/html/<id>vN` → `ar5iv.labs.arxiv.org/html/<id>`) 헬퍼 추가
- arXiv PDF 분기(`/pdf/`→`/html/`)와 일반 jina 분기 모두 broken 감지 → ar5iv 재시도 → 실패 시 URL-only
- 검증: `arxiv.org/pdf/2608.25720` 재수집 → 노트 `01m1rhsv99ss3abnnspg4gw2ws` 84KB 전문 확보 (SVG-only 아님)

---

## 4) CKCZ-19 · [Feature] LLM Wiki distill 서버 크론 (Workers AI)
- URL: https://linear.app/chukycheese/issue/CKCZ-19
- 상태: **Done** (`3d95b6a2` 배포) · 라벨: `Feature`

**작업:**
- `src/worker/routes/distill.ts` 신규 — `POST /api/distill` (`{note_id}`/`{limit}`/`{dry_run}`, Bearer) + `drainDistillQueue` (일 3건 캡, meta `distill:last_cron_day`)
- `app.ts` 라우트 등록, `requireClientHeader`에 `/api/distill` 바이패스, `index.ts` scheduled에 `drainDistillQueue(env, ctx, 3)`
- 대상: `Markdown Content:`(jina raw) 포함 + `> status: distilled` 미포함 + 본문 ≥400자 + broken 제외
- 모델: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` → 폴백 `@cf/qwen/qwen3-30b-a3b-fp8`
- 방식: raw 노트에 `## Wiki`(`> status: distilled` + TL;DR/핵심 요점/태그/메모) 프리펜드, 원문은 `---` 아래 유지
- 검증: `01m1epejj8c45pxzr4g00bdsnr` distill → `## Wiki` 마커 프리펜드 + 재실행 400 idempotency 확인

---

## 5) CKCZ-20 · [Feature] LLM Wiki query 오퍼레이션 — 검색+인용 합성 답변
- URL: https://linear.app/chukycheese/issue/CKCZ-20
- 상태: **Done** (`b8e818f0` → `e5f334b6` 배포) · 라벨: `Feature`

**작업:**
- `src/worker/lib/ai-chat.ts` 신규 — `runChatModel`(llama-3.3-70b → qwen3-30b 폴백) 공용화, `distill.ts`도 이걸 사용하도록 리팩터
- `src/worker/routes/query.ts` 신규 — `POST /api/query` (`{question, limit?, save?, folder_id?}`, Bearer): lexical(`searchUserNotes`) + semantic(`searchSemanticNotes`) → RRF 융합 → 상위 노트 본문 fetch → 모델이 `[[노트 제목]]` 인용 포함 한국어 답변 합성
- `save: true`면 `> status: answer` 노트로 저장, 응답에 `sources[]` 포함
- `app.ts` 라우트 등록 + `requireClientHeader` 바이패스 추가
- **리트리벌 전처리 수정**: 질문의 한국어 관사/의문사(`뭐고`/`언제` 등)가 AND 매칭을 망치는 문제 → `buildRetrievalQuery`(stopword + 라틴 토큰 접미 한글 제거)로 "CUPED가 언제 쓰이나"를 `cuped adjustment`로 정제해 실질 키워드 노트가 상위로 오게 수정
- 검증: `CUPED adjustment이 뭐고 언제 쓰는거야?` → datadog CUPED 노트 `01m1nsjsvnerbjh5pnhz7g1083`가 1위 소스, 인용 기반 답변; `save:true` → `01m1rn0102fcgmhkv3wj2eskrs` (`> status: answer` 노트)

---

## 6) CKCZ-21 · [Feature] LLM Wiki lint 오퍼레이션 + schema 문서
- URL: https://linear.app/chukycheese/issue/CKCZ-21
- 상태: **Done** (`b8e818f0` 배포) · 라벨: `Feature`

**작업:**
- `src/worker/routes/lint.ts` 신규 — `POST /api/lint` (`{dry_run?, save?, folder_id?}`, Bearer) + `runWikiLint` 크론(일 1회, meta `lint:last_cron_day`)
- SQL 기반 점검(LLM 미사용): 미처리 distill 후보, broken/short 캡처, 고아 노트(위키링크 0), 미해결 위키링크, 노트/폴더/단어 집계
- `save: true`/크론 시 `> status: lint` 보고서 노트를 `00 Inbox`에 저장, 크론은 계정별 1일 1건
- `docs/llm-wiki-schema.md` 작성 — 3계층(raw/wiki/schema)·마커·폴더·오퍼레이션(ingest/query/lint)·에이전트 체크리스트
- 검증: dry-run 리포트 — 71노트(24만 단어), distill 후보 25, broken 4, 고아 35, 미해결 링크 6, 중복 팟캐스트 캡처 5건 발견
---

## 7) Inbox distill & refresh — 2026-09-07
- 상태: **Done** · 관련: CKCZ-19 (distill)
- 작업:
  - Refresh 26건 (A/B/C/D) 로컬 `edit_note`로 `refresh: v3` 갱신, orca 4워크트리 검증 `ok`
  - Inbox distill 17건: 워커 15건 + 로컬 2건 (`Five Dysfunctions` + `JAMA` 짧은 건) — `rev 1→2` 후 `rev 3`으로 아카이브
  - Inbox `dry-run` 후보 0건 확인 (774자 1건은 기준 미달이나 distill 완료)
  - `scripts/llm-wiki-local-distill.mjs` + `ingest.mjs` → `main` 커밋 `e39379b`, `distill.ts` refresh 플래그 커밋 `f48ed50`
  - 워크트리/브랜치 정리: `verify-batchA~D` 제거, `chore/distill-refresh`·`chore/external-llm-mcp` 브랜치 삭제
- 검증:
  - Inbox `00` 17건 아카이브 `ok`, 전체 `dry-run` 0건, 최근 lint 368노트 기준 정리

## 8) Inbox distilled 정리 (남은 건)
- 상태: **Done** — `00 Inbox` distill 완료 14건 추가 아카이브
- 작업:
  - `00 Inbox` 내 `status: distilled` & `archived: false` 14건 일괄 아카이브 (`rev 2→3` 6건, `rev 4→5` 8건)
  - 대상: freecodecamp/oreilly/mattpaige/팟캐스트 4건/seattledataguy/openai/lint 리포트/scientificdiscovery/datadog/sundayletters 등
- 검증: 14건 모두 `ok`, Inbox 잔여는 `rev 1` EDR 등 미처리 5건 정도

---

## 9) CKCZ-45 · [Maintenance] Upstream Inkstone v0.8.0 릴리즈 및 신규 커밋 병합
- URL: https://linear.app/chukycheese/issue/CKCZ-45
- 상태: **Done** (`260d416`) · 라벨: `Improvement`

**작업:**
- 원본 저장소(`shuaiplus/inkstone`) v0.8.0 릴리즈 및 신규 14개 커밋 병합
- `src/worker/db/schema.ts`의 스키마 마이그레이션 충돌 해결 (`push_subscriptions`를 version 14로 분리, 원본 `backup_archives` version 13 유지)
- 주요 기능: 에디터 플로팅 찾기/바꾸기 패널, 캘린더 스케줄 백업/보존 정책, 오프라인 충돌 분리 보존 등 반영
- 타입체크 및 테스트 스위트 검증 통과

---

## 10) CKCZ-46 · [Knowledge Base] 00 Inbox 문서 115건 일괄 정리 및 분류/아카이브
- URL: https://linear.app/chukycheese/issue/CKCZ-46
- 상태: **Done**

**작업:**
- `00 Inbox` 누적 115건 문서 전면 정리:
  - 매일 생성된 일일 `LLM Wiki Lint Report` 29건 일괄 아카이브 (`is_archived = 1`)
  - Distill(Wiki 요약) 완료 문서 23건 주제별 적정 폴더로 이동:
    - `AI·Agents` (7건): Google Foresight, Hex Data Agent, Agentic Data Stack 등
    - `Data` (3건): Semantic Layer 관련 최신 아티클
    - `02 Papers` (3건): arXiv DAG-FM, Bayesian 확인 이론, AMS PDF 등
    - `10 English` (2건): IELTS Speaking 팟캐스트
    - `08 Workout` (1건): 운동 인스타그램
    - `05 Resources` (8건): YouTube 기술 세미나 및 기타 자료
  - 깨진 캡처(broken/svg-only 10건, 404 에러 3건), 테스트/더미 노트(8건), 빈 노트(2건) 총 23건 휴지통(`deleted_at`) 정리
- `00 Inbox` 활성 잔여 노트: 0건 달성 (Inbox Zero)

---

## 11) [Maintenance] 테스트 스위트 최신화 및 Inbox Zero 유지 정리 — 2026-11-15
- 상태: **Done** (`91aef60`) · 라벨: `Maintenance`

**작업:**
- **단위 테스트 정상화**: Node v26 환경에서 `SettingsPanel.test.ts`의 `localStorage` 누락 오류를 모킹하여 41개 테스트 파일(271개 전체 테스트) 100% 통과 복구
- **00 Inbox 정리 (Inbox Zero 재달성)**:
  - `Comet: Train a Decision Model (LLM-as-a-Judge)` 노트 제목 부여 및 `AI·Agents` 폴더로 분류 이동
  - Cloudflare 봇 감지 페이지만 캡처된 Wiley 문서 휴지통(`deleted_at`) 정리
  - 최근 8일간 자동 생성된 일일 `LLM Wiki Lint Report` 8건 일괄 아카이브
- **검증**: `00 Inbox` 활성 잔여 노트 0건 달성 (`active_inbox_count: 0`)

---

## 12) CKCZ-47 · [CI/Lint] check-i18n 및 check-comments 검증 스크립트 불일치 정상화
- URL: https://linear.app/chukycheese/issue/CKCZ-47
- 상태: **Todo** · 라벨: `Bug` / `CI`

**내용:**
- `npm run i18n:check` 실행 시 `tests/note-content-limit.test.ts`의 한자(中) 문자로 인해 실패하는 현상 해결
- `npm run comments:check` 실행 시 주석 검사 allowlist 누락 282건 정리
- CI 사전 검증 스크립트 전체 통과 복구

---

## 13) CKCZ-48 · [AI] Cloudflare Workers AI ↔ NVIDIA NIM 3차 Failover 결합
- URL: https://linear.app/chukycheese/issue/CKCZ-48
- 상태: **Todo** · 라벨: `Feature` / `AI`

**내용:**
- 위키 Distill / Query / Vocab 기능이 Cloudflare Workers AI에만 의존하여 무료 쿼터 초과 시 다운타임 발생 위험
- `src/worker/lib/ai-chat.ts`에 NVIDIA NIM API(`https://integrate.api.nvidia.com/v1`) 자동 Failover 안전망 구축

---

## 14) CKCZ-49 · [Knowledge Base] 고아 노트(Orphan Note) 및 미해결 위키링크 점검/해소
- URL: https://linear.app/chukycheese/issue/CKCZ-49
- 상태: **Todo** · 라벨: `Knowledge Base`

**내용:**
- 원격 D1의 LLM Wiki Lint Report에서 고아 노트 1건(제목 누락 `[[]]`), 미해결 위키링크 2건 보고됨
- 지식 그래프 정합성을 위해 고아 노트 정리 및 미해결 링크 해소

---

## 15) CKCZ-50 · [Git] 로컬 커밋 upstream/main 동기화 및 원격 푸시
- URL: https://linear.app/chukycheese/issue/CKCZ-50
- 상태: **Todo** · 라벨: `Maintenance`

**내용:**
- 로컬 `main` 브랜치에 단위 테스트 정상화 커밋 및 문서화 커밋 동기화
- `upstream/main`으로 `git push` 실행 및 원격 상태 확인



