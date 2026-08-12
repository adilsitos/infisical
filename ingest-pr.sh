#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <pr-url> [endpoint]"
  echo "  pr-url    GitHub PR URL (e.g. https://github.com/Infisical/infisical/pull/7615)"
  echo "  endpoint  Ingest endpoint (default: http://localhost:8081/ingest/pr-report)"
  exit 1
fi

PR_URL="$1"
ENDPOINT="${2:-http://localhost:8081/ingest/pr-report}"

# Extract PR number and repo from URL
if [[ "$PR_URL" =~ github\.com/([^/]+/[^/]+)/pull/([0-9]+) ]]; then
  REPO="${BASH_REMATCH[1]}"
  PR_NUMBER="${BASH_REMATCH[2]}"
else
  echo "Error: could not parse PR URL: $PR_URL"
  exit 1
fi

echo "==> Generating behavior review for PR #$PR_NUMBER..."
OUTPUT=$(cd backend/scripts/graphs && npm run behavior:review -- "$PR_URL" --print 2>&1)

# Extract the markdown path from the output
MD_PATH=$(echo "$OUTPUT" | sed -n 's/.*markdown \.* *//p' | tr -d '[:space:]')
if [ -z "$MD_PATH" ]; then
  echo "Error: could not find markdown path in output"
  echo "$OUTPUT"
  exit 1
fi

echo "==> Fetching diff..."
DIFF=$(gh pr diff "$PR_NUMBER" --repo "$REPO")

echo "==> Sending to $ENDPOINT..."
RESPONSE=$(jq -n --arg md "$(cat "$MD_PATH")" --arg diff "$DIFF" '{markdown: $md, diff: $diff}' | \
  curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d @-)

echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
