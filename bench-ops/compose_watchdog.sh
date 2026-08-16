#!/bin/bash
# Watchdog: kill `docker compose up --wait` processes older than 15 min.
# Harbor leaks them when env startup times out; each holds ~30MB and can
# accumulate enough to destabilize WSL. 15min > harbor's ~10min env timeout,
# so anything still alive at 15min was already abandoned by harbor.
while true; do
  for pid in $(pgrep -f "compose.*up --detach --wait"); do
    # etime like 01:11:41 (hh:mm:ss) or 15:00 (mm:ss)
    et=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$et" ] && [ "$et" -gt 900 ] 2>/dev/null; then
      echo "$(date +%H:%M:%S) killing leaked compose pid=$pid age=${et}s" >> /root/bench-logs/watchdog.log
      kill -9 "$pid" 2>/dev/null
    fi
  done
  sleep 120
done
