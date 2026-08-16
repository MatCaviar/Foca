#!/bin/bash
# Sequential launcher: runs 2 harbor jobs at a time (not 12)
# Prevents WSL crashes from too many concurrent Docker containers
export PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PYTHONPATH=/opt/dsh-agent
: "${DASHSCOPE_API_KEY:?export DASHSCOPE_API_KEY first}"

mkdir -p /root/bench-logs

run_job() {
  local BENCH="$1" MODEL="$2" ARM="$3" PROFILE="$4"
  local TASKS JOBS LOG

  if [ "$BENCH" = "tb21" ]; then
    TASKS=/mnt/d/AgenticSyS/bench/terminal-bench-2-1/tasks
  else
    TASKS=/mnt/d/AgenticSyS/bench/deepswe/tasks
  fi

  JOBS="/root/jobs/$MODEL-$ARM/$BENCH"
  LOG="/root/bench-logs/$BENCH-$MODEL-$ARM.log"
  mkdir -p "$JOBS"

  echo "[$(date +%H:%M:%S)] $BENCH: $MODEL $ARM ($PROFILE)"
  DSH_GUARD="$PROFILE" harbor run \
    -p "$TASKS" \
    -a "dsh_harbor_agent:DshHarborAgent" \
    -m "openai/$MODEL" \
    -e docker -o "$JOBS" --n-tasks 20 --n-concurrent 1 \
    > "$LOG" 2>&1
  echo "[$(date +%H:%M:%S)] $BENCH: $MODEL $ARM DONE (exit $?)"
}

# Run pairs: clean + guard for same model/bench
for bench in tb21 deepswe; do
  for model in qwen3.7-max qwen3.6-flash deepseek-v4-flash; do
    case $model in
      qwen3.7-max) profile="full" ;;
      *) profile="lite" ;;
    esac

    # Run clean and guard in parallel (2 concurrent)
    run_job "$bench" "$model" "clean" "off" &
    PID1=$!
    sleep 5
    run_job "$bench" "$model" "guard" "$profile" &
    PID2=$!

    echo "[$(date +%H:%M:%S)] Waiting for $model $bench pair..."
    wait $PID1 $PID2
    echo "[$(date +%H:%M:%S)] $model $bench pair complete"
    echo
  done
done

echo "[$(date +%H:%M:%S)] ALL BENCHMARKS COMPLETE"
