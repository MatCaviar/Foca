#!/bin/bash
# Verify TB2.1 completion: per-arm total trials, exceptions, passes, mean arithmetic
for m in qwen3.7-max qwen3.6-flash deepseek-v4-flash; do
  for a in clean guard; do
    d=$(ls -td /root/jobs/$m-$a/tb21/2026-08-1[56]__* 2>/dev/null | head -1)
    [ -n "$d" ] || continue
    python3 - "$d" "$m-$a" <<'EOF'
import json, sys, os
d, name = sys.argv[1], sys.argv[2]
r = json.load(open(os.path.join(d, 'result.json')))
s = r['stats']
n_total = s['n_total_trials']; n_comp = s['n_completed_trials']; n_err = s['n_errored_trials']
ev = list(s['evals'].values())[0]
mean = ev['metrics'][0]['mean']
p1 = ev['reward_stats']['reward'].get('1.0', [])
p0 = ev['reward_stats']['reward'].get('0.0', [])
print(f"{name}: total={n_total} completed={n_comp} errored={n_err} "
      f"pass={len(p1)} fail={len(p0)} mean={mean:.4f} "
      f"check pass/total={len(p1)/n_total:.4f} pass/completed={len(p1)/n_comp:.4f}")
EOF
  done
done
