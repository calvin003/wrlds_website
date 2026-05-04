#!/bin/bash
cd "$(dirname "$0")"
PORT=8765
echo "Serving WRLD Animation viewer at http://localhost:$PORT"
( sleep 1 && open "http://localhost:$PORT" ) &
python3 -m http.server "$PORT"
