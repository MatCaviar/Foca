"""Re-score saved tau2 trajectories with evaluator LLM calls routed to our model.

The stock evaluator hardcodes OpenAI/Anthropic models for NL assertions and
auth classification; without credentials those calls fail and the whole
simulation is recorded as an infrastructure error. This wrapper points those
constants at the DashScope-served model (via env OPENAI_API_KEY/OPENAI_BASE_URL
for keyless litellm calls) and re-runs the official evaluate-trajs pass over
the completed matrix, so both arms are graded by the same evaluator.
"""

from __future__ import annotations

import argparse
import os
import sys

import tau2.config as tau2_config


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="qwen3.6-flash")
    parser.add_argument("--api-base", default="https://dashscope.aliyuncs.com/compatible-mode/v1")
    parser.add_argument("--api-key", default=os.environ.get("DASHSCOPE_API_KEY", ""))
    parser.add_argument("--results", nargs="+", required=True)
    parser.add_argument("--out-suffix", default="")
    args = parser.parse_args()

    os.environ.setdefault("OPENAI_API_KEY", args.api_key or os.environ.get("DASHSCOPE_API_KEY", ""))
    os.environ.setdefault("OPENAI_BASE_URL", args.api_base)
    eval_model = f"openai/{args.model}"
    tau2_config.DEFAULT_LLM_NL_ASSERTIONS = eval_model
    tau2_config.DEFAULT_LLM_EVAL_USER_SIMULATOR = eval_model

    from tau2.cli import main as tau2_main

    # evaluate-trajs writes `updated_<name>.json` into the -o directory; run
    # once per results file into a sibling `-rescored` directory.
    for path in args.results:
        out_dir = path.replace("\\", "/").rsplit("/", 1)[0] + args.out_suffix
        sys.argv = [sys.argv[0], "evaluate-trajs", path, "-o", out_dir]
        print(f"rescoring {path} -> {out_dir}", flush=True)
        tau2_main()


if __name__ == "__main__":
    main()
