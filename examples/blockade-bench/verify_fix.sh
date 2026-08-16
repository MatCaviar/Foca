#!/bin/bash
export PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PYTHONPATH=/opt/dsh-agent
export DASHSCOPE_API_KEY=${DASHSCOPE_API_KEY:?}
export DSH_GUARD=off
cd /opt/dsh-agent
rm -rf /root/jobs/verify
timeout 600 harbor run \
  -p /mnt/d/AgenticSyS/bench/terminal-bench-2-1/tasks/cancel-async-tasks \
  -a "dsh_harbor_agent:DshHarborAgent" \
  -m openai/qwen3.6-flash \
  -e docker -o /root/jobs/verify --n-tasks 1 2>&1 | tail -5
