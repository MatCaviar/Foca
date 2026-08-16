#!/bin/bash
# Count completed harbor tasks per model/bench/arm
for j in qwen3.7-max-clean qwen3.7-max-guard qwen3.6-flash-clean qwen3.6-flash-guard deepseek-v4-flash-clean deepseek-v4-flash-guard; do
  for b in tb21 deepswe; do
    n=$(ls /root/jobs/$j/$b/*/result.json 2>/dev/null | wc -l)
    echo "$j/$b: $n"
  done
done
