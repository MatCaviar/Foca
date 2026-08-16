#!/bin/bash
export PATH="/root/.local/bin:$PATH"
export PYTHONPATH="/opt/dsh-agent"
: "${DASHSCOPE_API_KEY:?export DASHSCOPE_API_KEY first}"
cd /opt/dsh-agent

run_deepswe() {
  local M="$1" A="$2" P="$3"
  local J="/root/jobs/$M-$A/deepswe"
  mkdir -p "$J"
  echo "[$(date +%H:%M:%S)] DeepSWE: $M $A ($P)"
  DSH_GUARD="$P" nohup harbor run \
    -p /mnt/d/AgenticSyS/bench/deepswe/tasks \
    -a "dsh_harbor_agent:DshHarborAgent" \
    -m "openai/$M" \
    -e docker -o "$J" --n-tasks 20 --n-concurrent 1 \
    > "/root/bench-logs/deepswe-$M-$A.log" 2>&1 &
  sleep 2
}

run_deepswe "qwen3.7-max" "clean" "off"
run_deepswe "qwen3.7-max" "guard" "full"
run_deepswe "qwen3.6-flash" "clean" "off"
run_deepswe "qwen3.6-flash" "guard" "lite"
run_deepswe "deepseek-v4-flash" "clean" "off"
run_deepswe "deepseek-v4-flash" "guard" "lite"
echo "DeepSWE 6 jobs launched"
