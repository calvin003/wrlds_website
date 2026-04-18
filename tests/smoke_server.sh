#!/bin/bash
# Smoke-test the perl server without hanging the shell.
set -e
cd "$(dirname "$0")/.."
PORT=8753
perl serve.pl "$PORT" >/tmp/serve.log 2>&1 &
PID=$!
# Give the server a moment to bind, then probe.
sleep 0.5
trap "kill -9 $PID 2>/dev/null; true" EXIT

echo "--- GET /index.html ---"
curl -s -o /dev/null -w "status=%{http_code} type=%{content_type} size=%{size_download}\n" \
  "http://127.0.0.1:$PORT/index.html"

echo "--- GET /src/prompt.js ---"
curl -s -o /dev/null -w "status=%{http_code} type=%{content_type} size=%{size_download}\n" \
  "http://127.0.0.1:$PORT/src/prompt.js"

echo "--- GET /src/swarm.js ---"
curl -s -o /dev/null -w "status=%{http_code} type=%{content_type} size=%{size_download}\n" \
  "http://127.0.0.1:$PORT/src/swarm.js"

echo "--- GET /nonexistent ---"
curl -s -o /dev/null -w "status=%{http_code}\n" "http://127.0.0.1:$PORT/nonexistent"

kill -9 $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
echo "server log:"
cat /tmp/serve.log
