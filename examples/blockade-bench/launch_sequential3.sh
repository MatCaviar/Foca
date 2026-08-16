#!/bin/bash
# Sequential launcher v3: remaining DeepSWE jobs.
# Fix vs v2: empty BASE must NOT be exported as DASHSCOPE_BASE_URL=""
# (the bridge's ?? default only fires on undefined, not empty string).
export PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PYTHONPATH=/opt/dsh-agent

DASHSCOPE_KEY="${DASHSCOPE_API_KEY:?export DASHSCOPE_API_KEY first}"
DEEPSEEK_KEY="${DEEPSEEK_API_KEY:?export DEEPSEEK_API_KEY first}"
DEEPSEEK_BASE=https://api.deepseek.com/v1

mkdir -p /root/bench-logs

run_job() {
  local BENCH="$1" MODEL="$2" ARM="$3" PROFILE="$4" KEY="$5" BASE="$6"
  local TASKS JOBS LOG

  if [ "$BENCH" = "tb21" ]; then
    TASKS=/mnt/d/AgenticSyS/bench/terminal-bench-2-1/tasks
  else
    TASKS=/mnt/d/AgenticSyS/bench/deepswe/tasks
  fi

  JOBS="/root/jobs/$MODEL-$ARM/$BENCH"
  LOG="/root/bench-logs/$BENCH-$MODEL-$ARM.log"
  mkdir -p "$JOBS"

  echo "[$(date +%H:%M:%S)] $BENCH: $MODEL $ARM ($PROFILE) base=${BASE:-<default-dashscope>}"

  if [ -n "$BASE" ]; then
    export DASHSCOPE_BASE_URL="$BASE"
  else
    unset DASHSCOPE_BASE_URL
  fi

  DSH_GUARD="$PROFILE" \
  DASHSCOPE_API_KEY="$KEY" \
  harbor run \
    -p "$TASKS" \
    -a "dsh_harbor_agent:DshHarborAgent" \
    -m "openai/$MODEL" \
    -e docker -o "$JOBS" --n-tasks 20 --n-concurrent 1 \
    > "$LOG" 2>&1
  echo "[$(date +%H:%M:%S)] $BENCH: $MODEL $ARM DONE (exit $?)"
}

run_pair() {
  local BENCH="$1" MODEL="$2" PROFILE="$3" KEY="$4" BASE="$5"
  run_job "$BENCH" "$MODEL" "clean" "off" "$KEY" "$BASE" &
  PID1=$!
  sleep 5
  run_job "$BENCH" "$MODEL" "guard" "$PROFILE" "$KEY" "$BASE" &
  PID2=$!
  echo "[$(date +%H:%M:%S)] Waiting for $MODEL $BENCH pair..."
  wait $PID1 $PID2
  echo "[$(date +%H:%M:%S)] $MODEL $BENCH pair complete"
  echo
}

run_pair deepswe qwen3.7-max full "$DASHSCOPE_KEY" ""
run_pair deepswe qwen3.6-flash lite "$DASHSCOPE_KEY" ""
run_pair deepswe deepseek-v4-flash lite "$DEEPSEEK_KEY" "$DEEPSEEK_BASE"

echo "[$(date +%H:%M:%S)] ALL BENCHMARKS COMPLETE"
