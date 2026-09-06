#!/usr/bin/env bash
# Inkstone MCP 서버를 opencode에 등록한다.
#
# 인증 방식 두 가지를 지원한다:
#   1) OAuth 2.1 (기본):  opencode가 /mcp 리소스 메타데이터를 발견하고
#      PKCE + 동적 클라이언트 등록으로 브라우저 권한 흐름을 실행한다.
#   2) 정적 API 키:       INKSTONE_MCP_API_KEY(또는 프롬프트)로
#      `Authorization: Bearer ink_...` 헤더를 등록한다.
#
# 환경 변수:
#   INKSTONE_MCP_URL      MCP 엔드포인트 (기본: https://inkstone.inkstone.workers.dev/mcp)
#   INKSTONE_MCP_API_KEY  ink_... 정적 API 키 (설정 시 키 방식으로 등록)
set -euo pipefail

NAME="inkstone"
URL="${INKSTONE_MCP_URL:-https://inkstone.inkstone.workers.dev/mcp}"
KEY="${INKSTONE_MCP_API_KEY:-}"

echo "=== Inkstone MCP 등록 ==="
echo "Endpoint: $URL"

if [[ -z "$KEY" ]]; then
  if [[ "$URL" == "https://inkstone.inkstone.workers.dev/mcp" ]]; then
    echo "기본 URL을 그대로 쓰지 않도록 INKSTONE_MCP_URL(또는 INKSTONE_MCP_API_KEY)을 설정하세요." >&2
    exit 1
  fi
  printf "정적 API 키를 사용하려면 붙여넣으세요 (없으면 Enter → OAuth 2.1 흐름): "
  read -r KEY
fi

KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"

ARGS=("--url" "$URL")
if [[ -n "$KEY" ]]; then
  if [[ "$KEY" != ink_* ]]; then
    echo "경고: 키가 ink_ 로 시작하지 않습니다. 계속할까요? (y/n)"
    read -r CONFIRM
    if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
      echo "취소했습니다."
      exit 0
    fi
  fi
  ARGS+=(--header "Authorization=Bearer $KEY")
fi

opencode mcp add "$NAME" "${ARGS[@]}"
echo
if [[ -n "$KEY" ]]; then
  echo "등록 완료 (정적 API 키 방식). 세션을 재시작하면 inkstone 도구가 활성화됩니다."
else
  echo "등록 완료 (OAuth 방식). 최초 사용 시 /connect 또는 'opencode mcp auth $NAME'로 로그인합니다."
fi