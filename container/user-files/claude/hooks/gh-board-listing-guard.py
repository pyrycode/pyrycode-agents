#!/usr/bin/env python3
"""PreToolUse hook on Bash: refuse `gh project item-list` and name the cheap
alternatives.

That command asks for every field value of every card and costs about one
GraphQL point per requested slot, 303 for board 1, on the 5000-point hourly
budget every dispatcher, agent and session on this account shares. Sessions
used it about 140 times in the two weeks to 2026-09-22, mostly to learn one
ticket's column. Only an actual invocation is refused: the command has to sit
where a shell starts a command, so the phrase inside a commit message or an
echoed string passes.
"""
import json, re, sys

INVOCATION = re.compile(
    r"(?:^|[;&|(`\n]|\$\(|\b(?:then|do|else|xargs)\b)"   # where a command starts
    r"\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|command|exec|env|time|nice)\s+)*"
    r"(?:\S*/)?gh\s+project\s+item-list\b")

REASON = (
    "Blocked by the GitHub budget hook. `gh project item-list` costs about one "
    "GraphQL point per requested card slot, 303 for board 1, on the 5000-point "
    "hourly budget every dispatcher, agent and session shares. Use instead:\n"
    "- One ticket's column: `gh issue view <n> -R <owner>/<repo> --json projectItems`, about 2 points.\n"
    "- A whole board, one column, or a few tickets: `board-cards <board> [column | ticket numbers ...]`, "
    "about 2 points a page; add `--json` for labels, `--owner` for a board outside pyrycode.\n"
    "- The budget itself: `gh api graphql -f query='{rateLimit{remaining resetAt}}'`. "
    "`gh api rate_limit` misreports the GraphQL bucket.")


def main():
    try:
        command = json.load(sys.stdin)["tool_input"]["command"]
    except Exception:
        return  # never block on a payload this hook does not understand
    if INVOCATION.search(command):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": REASON}}))


if __name__ == "__main__":
    main()
