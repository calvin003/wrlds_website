#!/bin/bash
# Double-click this file in Finder to launch WRLD.
# Tries python3 first (if Xcode CLT is installed); otherwise falls back to a
# Perl static server, since Perl ships with macOS by default.
cd "$(dirname "$0")" || exit 1
PORT=8742
URL="http://localhost:$PORT/index.html"

echo "Serving WRLD at $URL"
echo "Leave this Terminal window open. Press Ctrl-C to stop."
echo

# Open the browser after a brief delay so the server has time to bind.
( sleep 1 && open "$URL" ) &

# Prefer python3 if it's really installed (not the Xcode stub).
if xcode-select -p >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
fi

# Fall back to a Perl static server (Perl is always present on macOS).
exec perl "$(dirname "$0")/serve.pl" "$PORT"
