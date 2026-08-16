#!/bin/bash
# Launch TB2.1 + DeepSWE for all model×arm combos
set -e
export PATH="/root/.local/bin:$PATH"
export PYTHONPATH="/opt/dsh-agent"
export DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY}"
export NUM_TASKS="${NUM_TASKS:-20}"

cd /opt/dsh-agent

launch_combo() {
  local MODEL="$1" ARM="$2" PROFILE="$3"
  local JOBS="/root/jobs/${MODEL}-${ARM}"
  mkdir -p "$JOBS" /root/bench-logs

  echo "[$(date +%H:%M:%S)] TB2.1: $MODEL $ARM ($PROFILE)"
  DSH_GUARD="$PROFILE" nohup harbor run \
    -p /mnt/d/AgenticSyS/bench/terminal-bench-2-1/tasks \
    -a "dsh_harbor_agent:DshHarborAgent" \
    -m "openai/$MODEL" \
    -e docker \
    -o "$JOBS/tb21" \
    --n-tasks "$NUM_TASKS" \
    --n-concurrent 1 \
    > "/root/bench-logs/tb21-${MODEL}-${ARM}.log" 2>&1 &

  echo "[$(date +%H:%M:%S)] DeepSWE: $MODEL $ARM ($PROFILE)"
  DSH_GUARD="$PROFILE" nohup harbor run \
    -p /mnt/d/AgenticSyS/bench/deepswe/tasks \
    -a "dsh_harbor_agent:DshHarborAgent" \
    -m "openai/$MODEL" \
    -e docker \
    -o "$JOBS/deepswe" \
    --n-tasks "$NUM_TASKS" \
    --n-concurrent 1 \
    > "/root/bench-logs/deepswe-${MODEL}-${ARM}.log" 2>&1 &

  sleep 2
}

launch_combo "qwen3.7-max" "clean" "off"
launch_combo "qwen3.7-max" "guard" "full"
launch_combo "qwen3.6-flash" "clean" "off"
launch_combo "qwen3.6-flash" "guard" "lite"
launch_combo "deepseek-v4-flash" "clean" "off"
launch_combo "deepseek-v4-flash" "guard" "lite"

echo "[$(date +%H:%M:%S)] All 12 harbor jobs launched"
