#!/usr/bin/env bash
set -euo pipefail

echo "=== Linear MCP 등록 ==="
printf "Linear API 키를 붙여넣으세요 (lin_api_...): "
read -r KEY

KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
if [[ -z "$KEY" ]]; then
  echo "키가 비어 있어 종료합니다." >&2
  exit 1
fi

if [[ "$KEY" != lin_api_* ]]; then
  echo "경고: 키가 lin_api_ 로 시작하지 않습니다. 계속할까요? (y/n)"
  read -r CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "취소했습니다."
    exit 0
  fi
fi

opencode mcp add linear --url https://mcp.linear.app/sse --header "Authorization=Bearer $KEY"
echo
echo "등록 완료. 이 opencode 세션을 재시작하면 linear 도구가 활성화됩니다."