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
- 상태: **In Progress** — `00 Inbox`에 남아 있는 기존 distilled 문서들 아카이브
- 다음: `00 Inbox` 내 `status: distilled` & `archived: false` 일괄 아카이브
