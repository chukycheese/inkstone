# LLM Wiki Schema

LLM Wiki는 지식베이스(KB)를 **계층**, **오퍼레이션**, **규율**의 세 축으로 관리한다.
이 문서는 그 "규율"을 정의한다 — 사람과 에이전트가 노트를 수집·정제·조회할 때
따르는 계층 구조, 마커 규칙, 폴더 규칙, 운영 가이드. (Karpathy의 LLM Wiki 컨셉 기준)

> 이 저장소의 `src/worker/routes/` 아래 구현(encode)과 이 문서의 규율(decode)은
> 한 방향으로만 흘러야 한다. 규율이 코드 검증 없이 추가되지 않도록, 코드 변경 시
> 이 문서를 함께 갱신한다.

## 1. 3계층

| 계층 | 위치 | 상태 | 설명 |
| --- | --- | --- | --- |
| raw | 02 Papers (및 활용 폴더)의 캡처 노트 | 수집 본문 그대로 | `Markdown Content:` 마커 뒤에 원문/전사본 저장 |
| wiki | 같은 노트의 `## Wiki` 섹션 | distil(정제) 완료 | `> status: distilled` 마커 + TL;DR/핵심 요점/태그/메모 |
| schema | `docs/llm-wiki-schema.md` (이 문서) | 수동 유지 | 계층·마커·폴더·오퍼레이션 규율 정의 |

- **한 노트 = 한 문서.** raw와 wiki를 별도 노트로 만들지 않는다. distill은 raw 노트의
  상단에 `## Wiki` 섹션을 **prepend**로 붙인다.
- 원본 가치가 높은 긴 문서는 raw만 두고 wiki 섹션으로 요약을 얹는 형태가 기본.

## 2. 마커 규칙

노트 본문에 상태를 기록한다 (Front Matter 아님 — Markdown이 소스 오브 트루스).

| 마커 | 의미 |
| --- | --- |
| `> status: distilled` | 아래(body의 시작 부분)에 `## Wiki` 정제 섹션이 있음 |
| `> status: answer` | query 오퍼레이션이 생성한 합성 답변 노트 |
| `> status: lint` | lint 오퍼레이션이 생성한 건강검진 보고서 |
| `Markdown Content:` | 캡처된 원문 본문의 시작 (capture가 삽입) |

- distill 후보 조건: `Markdown Content:` 존재 + `> status: distilled` 부재
  + 본문 400자 이상 + 검증되지 않은 broken 패턴이 아닐 것.
- 상태 마커가 "distilled"인데 `## Wiki` 섹션이 없는 노트는 lint가 걸러낸다.

## 3. 폴더 규칙

| 폴더 | 용도 |
| --- | --- |
| 00 Inbox | 새 캡처 기본 위치 + lint 보고서 |
| 01 Concepts | 개념/원칙/기준 문서 (Index 포함) |
| 02 Papers | 논문·아티클 원문 캡처 (raw) |
| 04 Projects | 프로젝트 진행·문답 노트 |
| 05 Resources | 재사용 자원/링크 모음 |
| 09 Archive | 완료·보관 |

- 캡처 기본 폴더는 00 Inbox. distill이 대상 폴더를 지정하지 않으면 전체에서 후보를 뽑는다.
- 위키링크 `[[노트 제목]]`은 제목 기준으로 자동 연결된다. 문서는 스스로를
  Index(`01 Concepts`의 Index 노트)에서 찾을 수 있게 연결돼야 한다.

## 4. 오퍼레이션

### ingest — 수집
- `POST /api/capture` `{title, url, content, folderId}`: URL 기반 서버 페치
  (r.jina.ai → arXiv는 HTML/ar5iv 폴백), 오디오 whisper 전사, PDF 처리.
- `POST /api/distill` `{note_id?, limit?, folder_id?, dry_run?}`: raw → wiki 정제.
  매시간 크론이 일일 3건 이내로 자동 실행(뉴런 예산), 수동 호출은 무제한.

### query — 조회·합성
- `POST /api/query` `{question, limit?, save?, folder_id?}`: 위키를 검색하고
  (FTS/LIKE + AI 시맨틱 RRF 융합) 그 자료에만 근거해 한국어 답변을 합성한다.
- **인용 규칙**: 모든 주장에 `[[노트 제목]]` 위키링크가 붙는다. 답변에 없는 사실을
  지어내지 않는다 — 자료에 없으면 "없다"고 말한다.
- `save: true`면 답변을 `> status: answer` 노트로 저장한다.

### lint — 건강검진
- `POST /api/lint` `{dry_run?, save?, folder_id?}`: 미처리 raw 캡처, broken 본문,
  고아 노트(위키링크 없음), 미해결 위키링크를 SQL로 집계한다 (LLM 미사용).
- 매시간 크론이 일일 1회 보고서 노트(`> status: lint`)를 00 Inbox에 생성한다.
- 발견 시 조치: broken → 재캡처, 고아 → Index/관련 문서와 연결, 미처리 → distill.

## 5. 인덱스 및 로그

- **Index 노트**(01 Concepts): 착륙 페이지. 배포·티켓 갱신 시 `갱신일`·`## Tickets`
  등을 수동으로 갱신한다 (자동화 대신 사람 확인을 거친다).
- **뉴런 예산**: Workers AI 무료 10k Neurons/일. distill(1일 3건)·임베딩(캡처 시)
  은 캡이 있어 안전하다. query는 사용자 발화 시에만 실행된다.

## 6. 에이전트 작업 시 체크리스트

1. 기존 노트를 먼저 검색한다 — 중복 캡처 금지.
2. 캡처 후에는 distill로 `## Wiki` 섹션을 만든다.
3. 위키링크를 항상 사용한다 — 평문 제목 대신 `[[제목]]`.
4. lint 보고서가 나오면 고아/브로큰을 정리하고, 정리한 뒤에는 보고서를 닫는다.
5. 이 문서(schema)를 변경하면 코드(인코더)와 동기화 여부를 확인한다.