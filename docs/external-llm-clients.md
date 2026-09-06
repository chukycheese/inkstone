# 외부 LLM 클라이언트 연결 가이드

Inkstone의 원격 MCP 서버에 **다른 LLM 앱**을 연결하는 방법을 정리한다.
Claude Desktop, Cursor, Gemini CLI, Codex CLI, ChatGPT 커넥터, 범용 MCP SDK,
`opencode` 등이 모두 이 배포의 `/mcp` 하나에 붙는다.

> 이 문서는 설정/연결 방법을 다룬다. 위키 규율(노트 계층·마커·폴더·오퍼레이션)은
> `docs/llm-wiki-schema.md`를 따른다. 코드 참조는 저장소 경로와 라인으로 표기한다.

## 0. 모바일 앱에서 위키 연결하기

Claude 모바일, ChatGPT, Gemini 모두 **"웹에서 서버를 한 번 등록하면 모바일에서
바로 쓴다"**는 구조다. 등록하는 URL은 전부 동일하다: `https://wiki.example.com/mcp`

| 앱 | 모바일 동작 | 서버 등록 위치 | 인증 | 주요 제약 |
| --- | --- | --- | --- | --- |
| Claude (iOS/Android) | iOS/Android 원격 MCP 지원(2025-07-26부터). **앱에서 직접 등록 불가** — 웹 등록 후 자동 동기화 | claude.ai (웹) → Settings → Connectors → Add Custom Connector | OAuth 2.1/DCR — 서버의 `/oauth/register`(`oauth.ts:83`) 자동 지원 | 서버가 퍼블릭 인터넷에서 연결 가능해야 함(Anthropic 클라우드에서 접속); 모바일에서 커스텀 커넥터 **설치**는 여전히 베타 |
| ChatGPT | 커넥터(2026-07 개편으로 "Plugins") — 웹 중심, 모바일 확장 중 | 웹 설정 → Developer Mode 켬 → Plugins 탭에서 MCP 서버 URL 추가 | OAuth 또는 **Token**(`ink_...` 정적 키) | 유료 플랜 필요; 원격 HTTPS 전용 |
| Gemini 앱 | 웹에서 "Custom apps for Spark" 연결 후 모바일 앱에서 사용 | gemini.google.com → 설정 → Connected Apps → Custom apps for Spark | OAuth/DCR — Advanced features의 Dynamic Client Registration 지원 | 개인 Google 계정만, 영어만, 18세+/미국, Spark 보유, Keep Activity 켜짐 필요 |

> 보안 권장: 모바일 커넥터는 스코프 확장이 긴 더 실행 흐름에 노출되므로
> **`notes:read`(읽기 전용)부터** 연결하고, 쓰기가 꼭 필요해지면 그때 `notes:write`를
> 더한다 (스코프 표는 §1 참고).

### 0.1 Claude 모바일 (iOS/Android)

Claude 모바일은 2025-07-26부터 원격 MCP 서버를 지원한다(로컬 스크립트는 모바일에서
불가하므로 원격 전용). 단, **앱 안에서 서버를 추가할 수는 없다** — claude.ai 웹에서
커넥터를 만들면 계정 단위로 Mobile·Desktop·Web에 동기화되고, 모바일 앱의 "+" 메뉴 →
Manage Connectors에서 대화별로 켜고 끈다.

1. claude.ai 웹에 로그인 → **Settings → Connectors → Add Custom Connector**.
   (Free/Pro/Max는 `Customize → Connectors`, Team/Enterprise는 소유자가
   `Organization settings → Connectors`에서 추가 — 멤버는 이후 개별 연결)
2. 서버 URL에 `https://wiki.example.com/mcp` 입력.
   Advanced settings 는 비워도 된다 — 이 서버는 DCR(`/oauth/register`)로 공개
   클라이언트를 자동 등록하므로 별도 Client ID/Secret이 필요 없다
   (`oauth.ts:83,112-135`). (참고: 요청 헤더 인증도 서버측으로는 지원되지만, Claude
   커넥터의 "Request headers"는 아직 베타라 OAuth 경로가 안정적이다.)
3. **Add** 후 모바일 앱에서 새 대화 → "+" 메뉴 → **Manage Connectors**에서 해당
   커넥터를 켠다. 첫 도구 사용 시 브라우저가 열리며 로그인·동의가 진행된다.
4. 연결 실패 점검: 커넥터는 접속이 **Anthropic 클라우드에서 나가므로** 서버가 퍼블릭
   인터넷에서 `https://<host>/mcp`로 401 챌린지(DCR 등록 지시)를 주는지 먼저 확인한다
   (§3 흐름, `PUBLIC_URL`은 §8).

출처: [claude.com/docs/connectors/custom/remote-mcp](https://claude.com/docs/connectors/custom/remote-mcp),
[support.claude.com — custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### 0.2 ChatGPT (Developer Mode 커넥터)

ChatGPT의 커스텀 MCP는 **Developer Mode** 뒤에 있다(유료 플랜 필요 — Plus/Pro/
Team/Enterprise/Edu; OpenAI는 현재 웹을 중심으로 Business/Enterprise/Edu에 전체 MCP를
순차 출시 중이고 모바일은 확장 단계다).

1. 웹 설정에서 **Developer mode**를 켠다 — 경로: `Settings → Security and login →
   Developer mode`. (2026-07 개편으로 "Connectors"는 "Plugins"로 개명됨. 개편 이전
   UI에서는 `Settings → Apps & Connectors → Advanced Settings → Developer Mode`였다.)
2. **Plugins** 탭으로 이동 → "+" → MCP 서버 URL에 `https://wiki.example.com/mcp` 입력.
3. 인증은 둘 중 하나:
   - **OAuth**: 서버가 DCR을 지원하므로 URL만 넣고 표준 인가 흐름을 따른다.
   - **Token**: 설정 → MCP에서 `ink_...` 정적 키를 생성하고($4) Token 필드에 붙여넣기
     (키는 `notes:read`가 하드필수·쓰기/휴지통은 계정 설정 기준, `api-keys.ts:64-65`).
4. 커스텀 커넥터는 **원격 HTTPS 전용**이다 — Inkstone `/mcp`가 그대로 해당한다.

출처: [help.openai.com — Developer mode and full MCP connectors in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).

### 0.3 Gemini 앱 (Connected Apps — "Custom apps for Spark")

Gemini 소비자 앱의 커스텀 MCP는 스파크 프로그램("Custom apps for Spark") 채널로만
연결된다. (Gemini API/SDK 자체의 네이티브 MCP 지원은 2025-05 I/O부터 시작됐지만
`blog.google`, 앱 UI 커스텀 MCP와는 별개다.)

1. gemini.google.com → **Settings & help → Connected Apps → Custom apps for Spark** →
   **Add a custom app**.
2. MCP 서버 URL에 `https://wiki.example.com/mcp`를 입력.
3. 인증: **Advanced features → Dynamic Client Registration**을 켜면 이 서버의
   `/oauth/register`(`oauth.ts:83`)가 자동으로 클라이언트를 등록해 준다. (서버가 DCR을
   지원하지 않는다면 "Show more"로 자격 증명을 직접 입력하는 방식인데, Inkstone은
   DCR을 지원하므로 그 체크박스를 쓰면 된다.)
4. 웹 연결 후 **Gemini 모바일 앱에서도** 그대로 사용할 수 있다.
5. 제약 (Google의 스파크 연결 기준): **개인 Google 계정만**(업무/학교 계정 불가),
   **영어만**, **18세 이상/미국**, **Gemini Spark 보유**, **Keep Activity 켜짐** 필요.
   해당 조건에 안 맞으면 이 기능 자체가 보이지 않는다.

출처: [support.google.com/gemini — Custom apps for Spark](https://support.google.com/gemini/answer/17209137).

## 1. 열려 있는 표면 (surface)

서버는 Cloudflare Workers의 `OAuthProvider`(<code>src/worker/mcp/oauth.ts:71</code>)와
`agents/mcp`의 stateless 핸들러(<code>src/worker/mcp/oauth.ts:30</code>)를 조합한다.
`OAUTH_KV` KV가 없으면 OAuth 자체가 뜨지 않으므로 배포에 `[[kv_namespaces]] OAUTH_KV`
바인딩이 반드시 필요하다 (<code>wrangler.toml:33</code>).

| 항목 | URL (예: `https://wiki.example.com`) | 출처 |
| --- | --- | --- |
| MCP 엔드포인트 (Streamable HTTP + SSE) | `https://wiki.example.com/mcp` | `oauth.ts:39,74` |
| OAuth 서버 메타데이터 (RFC 8414) | `https://wiki.example.com/.well-known/oauth-authorization-server` | `index.ts:23` |
| 보호 리소스 메타데이터 (RFC 9728) | `https://wiki.example.com/.well-known/oauth-protected-resource/mcp` | `oauth-provider.js` (패키지) |
| 인가 엔드포인트 + 로그인/동의 페이지 | `https://wiki.example.com/authorize` | `oauth.ts:81` |
| 토큰 + 리보크 엔드포인트 | `https://wiki.example.com/oauth/token` | `oauth.ts:82` |
| 동적 클라이언트 등록 (RFC 7591) | `https://wiki.example.com/oauth/register` | `oauth.ts:83` |
| MCP 설정 UI (로그인 후) | `https://wiki.example.com` → 설정 → MCP | `app.ts:103`, `McpSettings.tsx` |

- 인가 서버 `<code>issuer</code>`는 토큰 엔드포인트의 오리진(웹사이트 루트)이다.
- MCP 핸들러는 `route: '/mcp'` + `legacy: 'stateless'` + `responseMode: 'auto'`로
  2025-era(SSE/streamable-http)와 최신 프로토콜(per-request envelope)을 모두
  다룬다. Claude Desktop·opencode·Codex 등 2025-era 클라이언트와 그대로 호환된다
  (`oauth.ts:39-41`).
- 인증이 필요한 접근에 대해 `/mcp`는 RFC 6750/9728 형식의
  `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="<...>/.well-known/oauth-protected-resource/mcp", scope="notes:read notes:write notes:trash"`
  챌린지를 내려준다. 표준을 따르는 클라이언트는 이 챌린지에서 메타데이터를 발견한다.

### 인증 모델 (두 가지)

1. **OAuth 2.1 + PKCE (S256 전용)** — 기능이 완전한 MCP 클라이언트용.
   - `response_types: ["code"]`, `grant_types: ["authorization_code","refresh_token"]`,
     `token_endpoint_auth_methods: ["client_secret_basic","client_secret_post","none"]`
     (공개 클라이언트는 `none` + PKCE), `code_challenge_methods: ["S256"]`만 허용
     (`oauth.ts:92-94`, 패키지 기본값).
   - 액세스 토큰 TTL 1시간, 리프레시 토큰 TTL 30일, 동적 등록된 클라이언트 90일
     (`oauth.ts:95-97`).
   - 동적 클라이언트 등록(DCR) 지원 — 클라이언트가 등록 없이도 흐름을 시작할 수 있다.
     등록은 IP당 시간당 20건으로 스로틀된다 (`oauth.ts:112-135`).
2. **정적 API 키 (`ink_...`)** — 스크립트·범용 SDK·이름 없는 에이전트용.
   - `/mcp` 요청에 `Authorization: Bearer ink_...` 헤더 하나만 붙이면 된다
     (`oauth.ts:98-111`). 검증은 제공자의 `resolveExternalToken` 훅이 수행한다.
   - 키는 SHA-256 해시로만 저장되고 원문은 절대 재노출되지 않는다
     (`api-keys.ts:8`, `api-keys.ts:60-71`).

### 스코프와 권한 (`settings.ts:3-9`)

| 스코프 | 의미 | 인가 방식 |
| --- | --- | --- |
| `notes:read` | 검색·조회 (필수) | 항상 부여 (`mcp-authorize.ts:218`, `grantedMcpScopes`) |
| `notes:write` | 노트/폴더/태그/속성/첨부 수정, 공유·백업 실행 | 계정 설정 + 동의 페이지 체크박스 |
| `notes:trash` | 노트를 휴지통으로 (소프트 삭제만) | 계정 설정 + 별도 동의 (기본 꺼짐) |
| `offline_access` | 승인됨 — 리프레시 토큰 발급용 오프라인 표시 | 메타데이터에는 광고 안 됨, 요청은 허용 (`mcp-authorize.ts:128-130`) |

- 쓰기/휴지통은 **독립적인 두 개의 스위치**다. 기본값은 쓰기=켜짐, 휴지통=꺼짐
  (`settings.ts:87-93`). 스코프를 요청해도 계정 환경설정에서 꺼져 있으면 동의 페이지에
  나타나지 않고 권한도 부여되지 않는다 (`settings.ts:76-85`).
- 도구는 스코프를 강제한다. 읽기 도구는 `notes:read`(server.ts:103,135 등),
  쓰기 도구는 `notes:write`+환경설정(server.ts:970-979), 휴지통 도구는 `notes:trash`.

### 제공 도구 (39개, `server.ts:87-948`)

- **읽기/검색**: `search`, `fetch`, `search_notes`, `list_notes`, `read_note`,
  `get_note_context`, `explore_note_graph`, `list_folders`, `list_tags`,
  `list_note_versions`, `read_note_version`, `get_note_properties`,
  `query_note_properties`, `get_note_share`, `list_backup_runs`, `list_attachments`,
  `read_attachment`
- **쓰기**: `create_note`, `edit_note`, `organize_note`, `restore_note`,
  `duplicate_note`, `restore_note_version`, `create_folder`, `update_folder`,
  `create_tag`, `update_tag`, `delete_tag`, `preview_tag_change`,
  `preview_folder_removal`, `remove_folder_and_promote_contents`,
  `bulk_organize_notes`, `upload_attachment`, `delete_attachment`, `run_backup`,
  `create_note_share`, `revoke_note_share`, `update_note_properties`
- **휴지통**: `trash_note`
- 서버에 임베드된 인스트럭션(server.ts:67)은 연결된 에이전트가 노트 내용을
  **신뢰하지 않도록**(untrusted data), 검색→인출→구간 읽기 순서, 방향
  (write는 예약/리비전 검사), 공유 생성 전 명시적 요청, 영구 삭제·계정 관리 미노출
  규칙을 시행한다.

## 2. MCP 활성화/비활성화

기본 **켜짐**. 전역 스위치가 꺼져 있으면 `/mcp`는 403, DCR은 `access_denied`
(`oauth.ts:17-18,114-116`), `/authorize`는 "MCP is disabled" 페이지를 반환한다
(`mcp-authorize.ts:36-38`).

- **설정 UI**: 로그인 → 설정 → MCP → "Enable MCP" 스위치 (소유자만 조작 가능,
  `mcp-settings.ts:72-75`). 여기서 읽기 전용 URL, 쓰기/휴지통 스위치, API 키 관리,
  연결된 OAuth 그랜트 열람·일괄 리보크, AI 검색 인덱스도 조작한다.
- **메타 키로 직접**: DB 메타 `mcp-enabled-v1` 값이 `'0'`이면 꺼짐, 그 외는
  켜짐 (`settings.ts:11-28`). D1에서 직접 되돌리려면 값을 `'1'`로 세팅하면 된다
  (`setMcpEnabled`).
- 클라이언트가 이미 OAuth 그랜트를 받았다면 꺼지는 순간 그 그랜트로는 `/mcp`가
  401을 반환한다 (`oauth.ts:17-19`).

## 3. 범용 클라이언트 연결 (OAuth PKCE 흐름)

대부분의 최신 클라이언트(Claude·Cursor·Gemini CLI·Codex·opencode)는 아래를 자동으로
수행하므로 **URL 하나만 넣으면 된다**: `https://wiki.example.com/mcp`

1. 클라이언트가 `/mcp`를 POST하면 401 + `WWW-Authenticate` 챌린지를 받는다.
2. 챌린지의 `resource_metadata` URL(`/.well-known/oauth-protected-resource/mcp`)을
   읽어 인가 서버(`.well-known/oauth-authorization-server`)를 발견한다.
3. DCR(`/oauth/register`)로 공개 클라이언트를 등록한다 (PKCE, `token_endpoint_auth_method: none`).
4. 브라우저에서 `/authorize`를 열고 로그인 → `notes:read`(필수) + 선택 스코프에 동의.
   리다이렉트에는 RFC 9207 `iss` 파라미터가 붙는다 (`mcp-authorize.ts:159-167`).
5. `/oauth/token`에서 코드를 액세스/리프레시 토큰으로 교환하고 `/mcp`로 절차를 진행.
6. `/mcp`의 매 요청은 `Authorization: Bearer <access_token>` 헤더를 실어 보낸다.

Gemini CLI(`gemini mcp`), Cursor(MCP server as URL), ChatGPT 커넥터, Claude 모바일·
Gemini 모바일 모두 같은 방식으로 `/mcp` URL만 지정하면 된다. 모바일 앱은 앱 안에서
URL을 입력하는 대신 **각 앱의 웹 설정에서 커넥터를 등록**한 뒤 앱에서 활성화한다
(앱별 단계는 §0). 세부 지원 스코프 문법이 클라이언트별로 다르면
`notes:read`(읽기 전용이 기본 안전)부터 시작하고, 쓰기가 필요할 때만 `notes:write`
스코프를 더한다.

## 4. 범용 클라이언트 연결 (정적 `ink_...` 키)

OAuth를 돌리기 어려운 스크립트·SDK·테스트용 요청은 키 하나로 붙는다.

1. **키 생성**: 로그인 → 설정 → MCP → "API keys" → 이름 입력 → 생성.
   `ink_...` 원문은 **이 순간 한 번만** 표시된다 (`McpSettings.tsx:400-412`,
   `mcp-settings.ts:88-96`).
2. 키는 계정의 활성 쓰기/휴지통 환경설정을 그 시점 스코프로 스냅샷한다
   (`api-keys.ts:64-65`). 계정당 최대 50개 (`api-keys.ts:16,69-71`).
3. 연결:
   ```bash
   curl -X POST "https://wiki.example.com/mcp" \
     -H "Authorization: Bearer ink_..." \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"my-app","version":"1.0"}}}'
   ```
   이후 `tools/list`, `tools/call`를 같은 헤더로 호출하면 된다.
4. **폐기**: 설정의 API 키 목록에서 Revoke. 즉시 401 `invalid_token`로 무효화된다
   (`mcp-settings.ts:98-102`, `api-keys.ts:105-115`).

## 5. opencode

원격 MCP 서버로 등록하면 OAuth(자동) 또는 헤더(API 키) 둘 다 가능하다.

```bash
# (1) OAuth — URL만 등록. 첫 사용 시 브라우저로 자동 인가.
opencode mcp add inkstone --url "https://wiki.example.com/mcp"

# (2) 정적 API 키 — oauth 자동 감지를 끄고 헤더로 인증.
opencode mcp add inkstone --url "https://wiki.example.com/mcp" \
  --header "Authorization=Bearer ink_..."
```

등록 후 세션을 재시작하고, OAuth 쪽은 필요하면 `opencode mcp auth inkstone`으로
로그인 상태를 확인/재인가한다. 설정 방식을 미리 써둔 헬퍼 스크립트:
`bash scripts/add-inkstone-mcp.sh` — `INKSTONE_MCP_URL`(기본 `https://your-host.example/mcp`)과
`INKSTONE_MCP_API_KEY`(선택; 없으면 OAuth 또는 프롬프트)를 읽는다.

## 6. Claude Desktop (`claude_desktop_config.json`)

원격 MCP의 `streamableHttp`/`http` 형식으로 `/mcp`를 가리킨다. `type: "http"`가 현재
형식(2025-era streamable HTTP와 동일 선상), `type: "streamableHttp"`가 이전 명칭이다.
Claude는 `/mcp`에서 401 챌린지 → 보호 리소스 메타데이터 → OAuth 2.1 PKCE 흐름을
자동 실행하므로 URL과 옵션 스코프만 적는다.

```json
{
  "mcpServers": {
    "inkstone": {
      "type": "http",
      "url": "https://wiki.example.com/mcp",
      "oauth": {
        "scopes": ["notes:read", "notes:write"]
      }
    }
  }
}
```

- 유효성 검사: Claude Desktop에서 서버가 연결되고, 최초 툴 사용 시 브라우저 권한
  페이지가 뜨면 정상이다.
- 안내 문구는 설정 UI의 "Connect a client"에 Claude Code용
  `claude mcp add-json inkstone '{"type":"http","url":"<endpoint>","oauth":{"scopes":"..."}}'`
  스니펫으로도 제공된다 (`McpSettings.tsx:614-634`).

## 7. Codex CLI

Codex는 표준 OAuth 이전의 버그(openai/codex#31573)로 인해 메타데이터에
`authorization_response_iss_parameter_supported`가 없어야 로그인에 성공한다.
Inkstone은 인가 서버 메타데이터를 **이 플래그를 뺀 채** 제공하는 호환 훅을 이미 달고
있다 (`index.ts:17-30`, `index.ts:80-98`). RFC 9207 `iss` 파라미터 자체는 콜백에
계속 붙으므로 표준 준수 클라이언트에는 영향이 없다.

```bash
codex mcp add inkstone --url "https://wiki.example.com/mcp"
```

연결 시 Codex가 브라우저를 열고 로그인·동의를 진행한다.

## 8. 그 외 참고 사항

- **`PUBLIC_URL` 권장**: 기본적으로 오리진(issuer·엔드포인트)은 요청의 Host에서
  결정된다 (`oauth.ts:144-159`). 커스텀 도메인과 워커 등 여러 호스트가 서로를
  가리킬 수 있는 배포라면 `[vars]`에 `PUBLIC_URL = "https://wiki.example.com"`을
  설정해 표준 오리진을 고정하는 것이 안전하다. 로컬 개발은 localhost/127.0.0.1이
  허용 리스트에 있어 그대로 동작한다 (`oauth.ts:47-54,148-158`).
- **호스트 제한**: `/mcp` 요청의 Host가 배포 캐노니컬 호스트(및 localhost류)가 아니면
  403을 반환한다. 커스텀 도메인으로 접근하는 클라이언트는 캐노니컬 호스트로
  맞춰야 한다 (`oauth.ts:28-29,47`).
- **중복 `resource` 파라미터**: 일부 클라이언트(Claude 류)는 `/authorize`·`/oauth/token`에
  동일 `resource`를 중복 전송한다. 서버가 자동 병합해 준다 (`index.ts:54-78`).
- **AI 검색**: 인덱스·임베딩은 계정별 격리, 공개 조회 엔드포인트 없음
  (`mcp-settings.ts:104-140`). `semantic`/`hybrid` 모드는 이 검색이 활성화된 계정에서만
  의미가 있고 그 외에는 어휘 검색으로 동작한다 (server.ts:94-95).

## 9. 보안 노트

- 정적 키는 **해시 저장**(SHA-256, `api-keys.ts:60-71`)이며 원문 재조회가 불가능하다.
  유출된 키는 설정에서 **즉시 리보크**할 수 있다.
- 키/그랜트는 **계정에 묶이고**(`resolveExternalToken` → `userId`·`role`·`scopes`,
  oauth.ts:101-111) 스코프는 환경설정·동의 페이지에서 확정된다. 도구 호출마다
  스코프를 재검사한다 (`server.ts:981-984`).
- 전역 **MCP 스위치**가 비활성화되면 모든 연결(키, 그랜트, 신규 등록)이 거부된다.
- 노트 내용은 **도구가 읽는 순간에만** 요청한 AI 클라이언트로 전달된다. 탐색·
  검색은 메타데이터(제목·URL)만 다룬다. 이후 데이터는 그 클라이언트의 정책을 따른다
  (동의 페이지 문구, `mcp-authorize.ts:226-228,356-357`).
- 휴지통은 소프트 삭제 전용이고 **영구 삭제·계정·인증·백업 자격 증명 관리는 MCP에
  노출되지 않는다** (server.ts:67, server.ts:355-376 설명문).
- 백업 도구는 기존에 구성된 타깃을 실행할 뿐 자격 증명을 읽거나 바꾸지 않는다
  (`server.ts:806-823`).

## 10. 검증 근거 (로컬 실행 확인, 2026-09 기준)

`npm run dev`(vite + workerd, localhost:7712)에서 실제로 확인한 내용:

- `GET /.well-known/oauth-authorization-server` → issuer/authorize/token/register/
  scopes/grant_types/PKCE 등 정상. `authorization_response_iss_parameter_supported`
  키가 **없는 것**을 확인 (index.ts:90의 Codex 훅 동작).
- `GET /.well-known/oauth-protected-resource/mcp` → resource/authorization_servers/
  scopes_supported/bearer_methods_supported 정상.
- `POST /oauth/register` → 201, client_id 발급.
- `GET /authorize` (등록된 public client, PKCE) → 미로그인 시 로그인 페이지 200,
  중복 `resource` 정규화 정상.
- `/mcp` 미인증 POST → 401 + RFC 6750 챌린지.
- `/mcp` Bearer `ink_...` → initialize 200(SSE), `tools/list` 39개 반환 (server.ts:67
  인스트럭션 포함), `notifications/initialized` 202.
- 미인지 Host(`Host: evil.example.com`)로 `/mcp` → 403 (호스트 제한 동작 확인).
- 빈 DB에서 `POST /api/auth/register` → `POST /api/mcp/keys`(키 발급) → Bearer 인증까지
  전체 경로를 실행해 동작 확인.

위 내용은 전부 현재 코드 기준 표준 동작이며, 확인된 "주류 클라이언트를 막는 결함"은
없다. `docs/llm-wiki-schema.md`처럼 이 문서의 설정 지침을 바꾸려면 코드와 동기화
여부를 함께 확인한다.