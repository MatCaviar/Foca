#!/bin/bash
# DeepSWE entrypoint: reuse the paired launcher so endpoint, key, subset, and
# concurrency handling stay identical to Terminal-Bench runs.
set -euo pipefail

export FOCAS_BENCH=deepswe
exec "$(dirname "$0")/launch_sequential3.sh"
