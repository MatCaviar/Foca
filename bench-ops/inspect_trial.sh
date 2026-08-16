#!/bin/bash
# Inspect the current trial of a job dir: list files, show trial.log tail and bridge stderr
D="$1"
echo "=== FILES IN $D"
ls "$D" | head -15
TRIAL=$(ls "$D" | grep -v -E 'job.log|result.json|lock.json|config.json' | head -1)
echo "=== TRIAL: $TRIAL"
T="$D/$TRIAL"
ls "$T" 2>/dev/null
echo "=== trial.log tail"
tail -n 6 "$T/trial.log" 2>/dev/null
echo "=== bridge.stderr.log tail"
tail -c 500 "$T/bridge.stderr.log" 2>/dev/null
