# Chuky Wiki Capture Shortcut

iOS 공유 시트에서 원탭으로 Inkstone에 저장하는 단축어.

## 파일
- `ChukyWikiCapture.shortcut` — 서명된 파일 (iPhone/iPad에서 바로 가져오기, AirDrop/파일 앱에서 탭)
- `ChukyWikiCapture.unsigned.shortcut` — 원본 바이너리 plist (Mac에서 `shortcuts sign`으로 재서명 가능)
- `ChukyWikiCapture.plist` — XML 형태 (디버깅/수정용)

## 동작
1. 공유 시트 입력 (URL/텍스트/사파리 페이지) 받기
2. 텍스트 포맷팅: `# {제목}\n> 출처: {URL}\n> 수집: {현재날짜}\n\n{본문}`
3. `POST https://inkstone.inkstone.workers.dev/api/capture` 로 전송
   - 헤더: `Authorization: Bearer ink_...` (가져오기 시 입력)
   - 바디: `{"title","content","url","folderId":"01m0m5w6n0mgdv2797hcygkpd1"}` (00 Inbox)
4. 결과 알림 `저장 완료!`

백엔드: `src/worker/routes/capture.ts:1` — `X-Inkstone-Client` 불필요, `operation_id` 서버 자동 생성.

## 설치
1. iPhone/Mac에서 `ChukyWikiCapture.shortcut` 탭 → 단축어 앱에서 열기
2. 가져오기 시 API 키 질문에 `ink_...` 붙여넣기 (Inkstone 설정 → MCP → API 키 발급, `notes:write` 스코프)
3. 단축어 상세에서 **공유 시트에 표시** 켜져 있는지 확인
4. 사파리에서 공유 → `Chuky Wiki Capture` 실행

키 변경: 단축어 편집 → `URL 내용 가져오기` 액션 → 헤더 `Authorization` 값 수정.

## 검증
```bash
curl -X POST https://inkstone.inkstone.workers.dev/api/capture \
  -H "Authorization: Bearer ink_..." \
  -H "Content-Type: application/json" \
  -d '{"title":"테스트","content":"# 테스트\n> 출처: https://example.com\n본문","folderId":"01m0m5w6n0mgdv2797hcygkpd1"}'
# 201 {ok:true, note:{id, url}}
```

## 재생성
```bash
python3 /tmp/gen_final.py  # shortcuts/ 폴더에 재생성
shortcuts sign --input shortcuts/ChukyWikiCapture.unsigned.shortcut --output shortcuts/ChukyWikiCapture.shortcut --mode anyone
```
