"""Run one (model x arm) tau2-bench evaluation with the DshAgent backend.

Usage:
  python run_arm.py --model qwen3.7-max --arm guard --out <dir> [extra tau2 args...]

Registers the dsh_agent factory, then hands control to the official tau2 CLI
so scoring, retries, and result serialization stay entirely upstream.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dsh_agent import register  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--arm", choices=["clean", "guard", "guard-lite"], required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--api-key", default=os.environ.get("DASHSCOPE_API_KEY", ""))
    parser.add_argument(
        "--api-base",
        default="https://dashscope.aliyuncs.com/compatible-mode/v1",
        help="OpenAI-compatible base URL for both the bridge and the user simulator",
    )
    args, extra = parser.parse_known_args()

    register()

    # Route the stock evaluator's hardcoded LLM calls (NL assertions, auth
    # classification) at the same DashScope model; without this those calls
    # fail keyless and poison whole simulations as infrastructure errors.
    import tau2.config as tau2_config

    os.environ.setdefault("OPENAI_API_KEY", args.api_key)
    os.environ.setdefault("OPENAI_BASE_URL", args.api_base)
    eval_model = f"openai/{args.model}"
    tau2_config.DEFAULT_LLM_NL_ASSERTIONS = eval_model
    tau2_config.DEFAULT_LLM_EVAL_USER_SIMULATOR = eval_model
    # The consumers bound the constants at their own import; repoint those
    # bindings too, or the patch above never reaches the call sites.
    import tau2.evaluator.evaluator_nl_assertions as nl_assertions
    import tau2.evaluator.auth_classifier as auth_classifier

    if hasattr(nl_assertions, "DEFAULT_LLM_NL_ASSERTIONS"):
        nl_assertions.DEFAULT_LLM_NL_ASSERTIONS = eval_model
    if hasattr(auth_classifier, "DEFAULT_LLM_EVAL_USER_SIMULATOR"):
        auth_classifier.DEFAULT_LLM_EVAL_USER_SIMULATOR = eval_model

    usage_dir = os.path.join(os.path.dirname(args.out), "usage")
    os.makedirs(usage_dir, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)
    agent_args = json.dumps(
        {
            "guard": False if args.arm == "clean" else (True if args.arm == "guard" else "lite"),
            "repo": REPO,
            "api_key": args.api_key,
            "api_base": args.api_base,
            "usage_file": os.path.join(usage_dir, f"{args.model}-{args.arm}.jsonl"),
            "bridge_stderr": os.path.join(args.out, "bridge.stderr.log"),
        }
    )
    user_args = json.dumps(
        {
            "api_base": args.api_base,
            "api_key": args.api_key,
        }
    )

    argv = [
        sys.argv[0],
        "run",
        "--domain",
        "retail",
        "--task-split-name",
        "test",
        "--agent",
        "dsh_agent",
        "--agent-llm",
        args.model,
        "--agent-llm-args",
        agent_args,
        "--user",
        "user_simulator",
        "--user-llm",
        f"openai/{args.model}",
        "--user-llm-args",
        user_args,
        "--num-trials",
        "1",
        "--max-steps",
        "40",
        "--max-concurrency",
        "2",
        "--timeout",
        "1200",
        "--auto-resume",
        "--save-to",
        args.out,
        *extra,
    ]
    sys.argv = argv
    from tau2.cli import main as tau2_main

    tau2_main()


if __name__ == "__main__":
    main()
