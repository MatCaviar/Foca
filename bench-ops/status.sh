#!/bin/bash
# One-shot benchmark status: current pair, trial counts, log tails, watchdog
date +%H:%M:%S
echo '=== HARBOR PROCESSES ==='
ps aux | grep 'harbor run' | grep -v grep | grep -o 'jobs/[a-z0-9.-]*/[a-z0-9]*' || echo none
echo '=== TRIAL COUNTS (this run) ==='
for d in /root/jobs/*/tb21 /root/jobs/*/deepswe; do
  [ -d "$d" ] || continue
  run=$(ls -t "$d" 2>/dev/null | head -1)
  [ -n "$run" ] || continue
  n=$(ls "$d/$run" 2>/dev/null | grep -cv -E 'job.log|result.json|lock.json|config.json')
  echo "$d : $n trials ($run)"
done
echo '=== ACTIVE LOG TAILS ==='
for f in /root/bench-logs/tb21-deepseek-v4-flash-clean.log /root/bench-logs/tb21-deepseek-v4-flash-guard.log; do
  echo "--- $f"
  tail -n 2 "$f" 2>/dev/null
done
echo '=== WATCHDOG ==='
tail -n 3 /root/bench-logs/watchdog.log 2>/dev/null || echo idle
