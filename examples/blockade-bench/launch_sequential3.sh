#!/bin/bash
# Paired clean/Focas launcher. Leave FOCAS_N_TASKS unset for a full local dataset.
set -euo pipefail

export PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PYTHONPATH=/opt/dsh-agent

DASHSCOPE_KEY="${DASHSCOPE_API_KEY:?export DASHSCOPE_API_KEY first}"
DEEPSEEK_KEY="${DEEPSEEK_API_KEY:?export DEEPSEEK_API_KEY first}"
DEEPSEEK_BASE=https://api.deepseek.com/v1
N_CONCURRENT="${FOCAS_CONCURRENCY:-1}"

mkdir -p /root/bench-logs

run_job() {
  local bench="$1" model="$2" arm="$3" profile="$4" key="$5" base="$6"
  local tasks jobs log
  local -a task_args=()

  if [ "$bench" = "tb21" ]; then
    tasks=/mnt/d/AgenticSyS/bench/terminal-bench-2-1/tasks
  else
    tasks=/mnt/d/AgenticSyS/bench/deepswe/tasks
  fi
  if [ -n "${FOCAS_N_TASKS:-}" ]; then
    task_args+=(--n-tasks "$FOCAS_N_TASKS")
  fi

  jobs="/root/jobs/$model-$arm/$bench"
  log="/root/bench-logs/$bench-$model-$arm.log"
  mkdir -p "$jobs"

  echo "[$(date +%H:%M:%S)] $bench: $model $arm ($profile) tasks=${FOCAS_N_TASKS:-all} concurrency=$N_CONCURRENT"
  if [ -n "$base" ]; then
    export DASHSCOPE_BASE_URL="$base"
  else
    unset DASHSCOPE_BASE_URL
  fi

  DSH_GUARD="$profile" DASHSCOPE_API_KEY="$key" harbor run \
    -p "$tasks" \
    -a "dsh_harbor_agent:DshHarborAgent" \
    -m "openai/$model" \
    -e docker -o "$jobs" "${task_args[@]}" --n-concurrent "$N_CONCURRENT" \
    > "$log" 2>&1
  echo "[$(date +%H:%M:%S)] $bench: $model $arm done"
}

run_pair() {
  local bench="$1" model="$2" profile="$3" key="$4" base="$5"
  run_job "$bench" "$model" clean off "$key" "$base" &
  local clean_pid=$!
  sleep 5
  run_job "$bench" "$model" guard "$profile" "$key" "$base" &
  local guard_pid=$!
  echo "[$(date +%H:%M:%S)] waiting for $model $bench pair"
  wait "$clean_pid" "$guard_pid"
  echo "[$(date +%H:%M:%S)] $model $bench pair complete"
}

BENCH="${FOCAS_BENCH:-deepswe}"
run_pair "$BENCH" qwen3.7-max full "$DASHSCOPE_KEY" ""
run_pair "$BENCH" qwen3.6-flash lite "$DASHSCOPE_KEY" ""
run_pair "$BENCH" deepseek-v4-flash lite "$DEEPSEEK_KEY" "$DEEPSEEK_BASE"

echo "[$(date +%H:%M:%S)] all paired evaluations complete"
