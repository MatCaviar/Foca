#!/bin/bash
export PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PYTHONPATH=/opt/dsh-agent
: "${DASHSCOPE_API_KEY:?export DASHSCOPE_API_KEY first}"

mkdir -p /root/bench-logs

for combo in "qwen3.7-max:clean:off" "qwen3.7-max:guard:full" "qwen3.6-flash:clean:off" "qwen3.6-flash:guard:lite" "deepseek-v4-flash:clean:off" "deepseek-v4-flash:guard:lite"; do
  IFS=':' read -r MODEL ARM PROFILE <<< "$combo"

  for BENCH in tb21 deepswe; do
    if [ "$BENCH" = "tb21" ]; then
      TASKS=/mnt/d/AgenticSyS/bench/terminal-bench-2-1/tasks
    else
      TASKS=/mnt/d/AgenticSyS/bench/deepswe/tasks
    fi

    JOBS="/root/jobs/$MODEL-$ARM/$BENCH"
    mkdir -p "$JOBS"

    echo "[$(date +%H:%M:%S)] $BENCH: $MODEL $ARM ($PROFILE)"
    DSH_GUARD="$PROFILE" nohup harbor run \
      -p "$TASKS" \
      -a "dsh_harbor_agent:DshHarborAgent" \
      -m "openai/$MODEL" \
      -e docker -o "$JOBS" --n-tasks 20 --n-concurrent 1 \
      > "/root/bench-logs/$BENCH-$MODEL-$ARM.log" 2>&1 &
    sleep 1
  done
done
echo "[$(date +%H:%M:%S)] All 12 jobs launched"
