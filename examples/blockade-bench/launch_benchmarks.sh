#!/bin/bash
# Launch all three benchmarks in parallel on E-drive Docker.
# Usage: bash /opt/launch_benchmarks.sh <model> <arm> <profile>
# Runs TB2.1 + DeepSWE concurrently through harbor, ALE through ale_run.

set -e
export PATH="/root/.local/bin:/opt/ale-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PYTHONPATH="/opt/dsh-agent"
export DASHSCOPE_API_KEY="${DASHSCOPE_API_KEY}"
export DSH_GUARD="${3:-off}"  # off | full | lite

MODEL="$1"
ARM="$2"
PROFILE="${3:-off}"
NUM_TASKS="${NUM_TASKS:-20}"  # subset for initial validation; set -1 for full
JOBS_DIR="/root/jobs/${MODEL}-${ARM}"
LOG_DIR="/root/bench-logs"

mkdir -p "$JOBS_DIR" "$LOG_DIR"

echo "[$(date)] Launching: model=$MODEL arm=$ARM profile=$PROFILE tasks=$NUM_TASKS"

# --- TB2.1 ---
if [ ! -f "$JOBS_DIR/tb21-done" ]; then
  echo "[$(date)] Starting TB2.1..."
  cd /opt/dsh-agent
  DSH_GUARD="$PROFILE" harbor run \
    -p /mnt/d/AgenticSyS/bench/terminal-bench-2-1/tasks \
    -a "dsh_harbor_agent:DshHarborAgent" \
    -m "openai/$MODEL" \
    -e docker \
    -o "$JOBS_DIR/tb21" \
    --n-tasks "$NUM_TASKS" \
    --n-concurrent 2 \
    > "$LOG_DIR/tb21-${MODEL}-${ARM}.log" 2>&1 &
  TB21_PID=$!
  echo "TB2.1 PID: $TB21_PID"
fi

# --- DeepSWE ---
if [ ! -f "$JOBS_DIR/deepswe-done" ]; then
  echo "[$(date)] Starting DeepSWE..."
  cd /opt/dsh-agent
  DSH_GUARD="$PROFILE" harbor run \
    -p /mnt/d/AgenticSyS/bench/deepswe/tasks \
    -a "dsh_harbor_agent:DshHarborAgent" \
    -m "openai/$MODEL" \
    -e docker \
    -o "$JOBS_DIR/deepswe" \
    --n-tasks "$NUM_TASKS" \
    --n-concurrent 1 \
    > "$LOG_DIR/deepswe-${MODEL}-${ARM}.log" 2>&1 &
  DEEPSWE_PID=$!
  echo "DeepSWE PID: $DEEPSWE_PID"
fi

# --- ALE (Docker subset) ---
if [ ! -f "$JOBS_DIR/ale-done" ]; then
  echo "[$(date)] Starting ALE Docker subset..."
  # ALE uses its own framework; create experiment yaml
  cat > /tmp/ale-exp-${MODEL}-${ARM}.yaml << EOF
experiment_name: reframe-${MODEL}-${ARM}
task_data_source: local:task-data
output_path: /root/jobs/${MODEL}-${ARM}/ale-output
snapshots:
  cpu-free-ubuntu:
    provider: docker
    image: agentslastexam/ale-ubuntu22-docker
    docker:
      shm_size: 2g
      resolution: [1024, 768]
agents:
  - harness: openai_compatible
    model: ${MODEL}
    config:
      api_base: \${OPENAI_BASE_URL}
      api_key: \${OPENAI_API_KEY}
EOF
  cd /mnt/d/AgenticSyS/bench/ale
  /opt/ale-venv/bin/python -m ale_run run /tmp/ale-exp-${MODEL}-${ARM}.yaml \
    > "$LOG_DIR/ale-${MODEL}-${ARM}.log" 2>&1 &
  ALE_PID=$!
  echo "ALE PID: $ALE_PID"
fi

echo "[$(date)] All launched. Waiting..."
wait
echo "[$(date)] All benchmarks complete for ${MODEL}-${ARM}"
