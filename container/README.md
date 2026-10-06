# Dispatcher container

Runs the pyrycode and pyrycode-desktop dispatchers, and every agent they spawn, inside rootless Podman containers on pyrybox instead of on the Mac. Decided 2026-10-03: the Mac's CPU was shared with the mobile pipeline's Gradle builds and test emulators, and verifier gates kept timing out under that load. One image serves both pipelines; `FORK` picks which one a container runs. Any OCI engine builds the image, so the runtime can move to another Linux machine later.

## What runs where

| Piece | pyrycode (board 1) | pyrycode-desktop (board 7) |
|---|---|---|
| Image | `localhost/pyrycode-agent-runtime:latest` | same image, `FORK=pyrycode-desktop` |
| Repositories and worktrees | `~/pyrycode-runtime/work` at `/work`, shared | same |
| Claude state, transcripts, caches | `~/pyrycode-runtime/home` | `~/pyrycode-runtime/home-desktop` |
| Settings | `config/dispatcher.env`, from `forks/pyrycode.env` | `config-desktop/dispatcher.env`, from `forks/pyrycode-desktop.env` |
| Service | `pyrycode-dispatcher.container` | `pyrycode-desktop-dispatcher.container` |

Both use the same four Podman secrets: `pyrycode-github-token`, `pyrycode-claude-token`, `pyrycode-discord-webhook` and `pyrycode-dev-agents-token`. The forks share `/work` so the desktop container can index pyrycode's docs, which its roles search for cross-project lessons. Each fork has its own home, because Claude rewrites `~/.claude.json` and two containers must not share it.

Containers run with `--userns=keep-id`, so they have exactly the pyry account's rights and every file they write belongs to pyry. Each may use six of the eight CPU threads; when both pipelines run gates at once, they share the CPU. Memory is capped at 16 GB for both together, by the systemd user slice `pyrycode-agents.slice` that both units run in. That leaves about half of pyrybox's 31 GB to Pyry and the system. Ad-hoc `podman run` commands sit outside the slice, so give them `--memory=16g` themselves.

## Steps

All commands below run on the Mac from this folder unless marked pyrybox.

1. **Build:** `./deploy.sh`. It copies this folder, installs both settings files, builds the image and prints tool versions. It starts nothing.
2. **Secrets:** `./push-secrets.sh`. The GitHub token comes from its own 1Password item, scoped to this container (Automation vault, item "GitHub pyrybox container token"), not from the Mac dispatchers' `.env`. The other three secrets' `op://` references are still read from the Mac pyrycode agents repo's `.env`. Both forks use the same references.
3. **Provision and smoke test** (pyrybox). The first run clones the repositories and builds the qmd and codegraph indexes on the CPU, which takes a long time. For desktop, add `-e FORK=pyrycode-desktop --shm-size=2g` and use `home-desktop` and `config-desktop`:
   ```bash
   podman run --rm --init --userns=keep-id --memory=16g \
     -v ~/pyrycode-runtime/work:/work -v ~/pyrycode-runtime/home:/home/agent \
     -v ~/pyrycode-runtime/config:/config:ro \
     --secret pyrycode-github-token,type=env,target=GITHUB_TOKEN \
     --secret pyrycode-claude-token,type=env,target=CLAUDE_CODE_OAUTH_TOKEN \
     --secret pyrycode-discord-webhook,type=env,target=DISCORD_WEBHOOK_URL \
     localhost/pyrycode-agent-runtime:latest smoke
   ```
4. **Switch over.** Only one dispatcher may watch a board:
   1. Mac: drain that fork's dispatcher with `bin/pyry-drain` in its agents repo and wait until it exits.
   2. pyrybox: install and start the service, shown for pyrycode; use the desktop unit name for desktop. The slice is shared, so installing it again is harmless:
      ```bash
      mkdir -p ~/.config/containers/systemd ~/.config/systemd/user
      cp ~/pyrycode-runtime/build/pyrycode-agents.slice ~/.config/systemd/user/
      cp ~/pyrycode-runtime/build/pyrycode-dispatcher.container ~/.config/containers/systemd/
      systemctl --user daemon-reload
      systemctl --user start pyrycode-dispatcher
      journalctl --user -u pyrycode-dispatcher -f
      ```
5. **Roll back** (pyrybox): `systemctl --user stop pyrycode-dispatcher`, which drains first, then remove the unit file and run `systemctl --user daemon-reload`. After that, start `bin/pyry-start` on the Mac again.

## Desktop specifics

- **Display:** Electron needs an X display even with hidden windows. The entrypoint starts Xvfb on `:99` for the desktop fork, and gates and agents inherit `DISPLAY`. `pyry-container shell` opens a shell with the display running, for debugging.
- **Shared memory:** Chromium crashes on Podman's default 64 MB `/dev/shm`, so the desktop unit sets `--shm-size=2g`.
- **Chromium for the static visual capture** comes from Playwright, in `/opt/ms-playwright`. `PLAYWRIGHT_VERSION` in the `Containerfile` must match the desktop repo's locked `@playwright/test`. Electron itself is downloaded by `npm install` into `~/.cache/electron`.
- **Daemon for the real-claude specs:** `PYRY_BIN` is the image's pinned pyry, v0.37.0 since 2026-10-06. `forks/pyrycode-desktop.env` sets the same version as `PYRY_HEALTH_DAEMON_MIN_VERSION`, so raise both together.
- **Figma:** desktop UI tickets need it; the builder stops a UI ticket as blocked without it. Codex in the desktop container reads Figma since 2026-10-04: `user-files/codex/figma.toml` is appended to the desktop fork's Codex config only, and the OAuth login is stored in `home-desktop/.codex/.credentials.json`. Verified with the dispatcher's own Codex arguments: `whoami` and `get_metadata` on the design file both worked. To sign in again, on pyrybox run `codex mcp login figma` in a desktop container with `--network=host`. The callback port is fixed at 18765 in the Codex config. From the Mac, run `ssh -N -L 127.0.0.1:18765:127.0.0.1:18765 pyrybox` through the Automation key. Then open the printed link in the Mac's browser. Never use `--no-browser`: it asks for the callback URL, which carries a one-time code, to be pasted. The Claude runner's Figma plugin is not signed in; sign it in only if the desktop fork goes back to Claude.

## Codex runner

The image includes Codex, so a dispatcher can run with `--runner codex` or `PYRY_AGENT_RUNNER=codex`. Codex logs in with a ChatGPT account, not a token, so it needs a one-time device login of its own per home folder. Do not copy the Mac's `~/.codex/auth.json`: two machines refreshing one login can sign the Mac out. On pyrybox:

```bash
podman run --rm -it --userns=keep-id -v ~/pyrycode-runtime/home:/home/agent \
  localhost/pyrycode-agent-runtime:latest codex-login
```

It prints a URL and a code to approve in a browser on any device. For the desktop fork, add `-e FORK=pyrycode-desktop` and mount `home-desktop`. Both homes were logged in on 2026-10-04. The login is stored in the home folder's `.codex/auth.json`, readable by the pyry account like the other secrets.

Both forks run on Codex since 2026-10-04.

**Switching runners needs no restart.** The dispatcher reads a runner file before every agent run (agent-dispatcher#112). For each fork it is `runner.json` in that fork's config folder on pyrybox: `~/pyrycode-runtime/config/runner.json` for pyrycode and `config-desktop/runner.json` for desktop. Edit it there, and the next agent run uses the new choice:

```json
{"runner": "claude"}
{"runner": "codex", "roles": {"verifier": "claude"}}
```

- **Precedence:** a role entry beats `runner`.
- **Fallback:** `PYRY_AGENT_RUNNER=codex` in `forks/*.env` applies when the file is absent.
- **Broken file:** an invalid edit keeps the last valid choice and logs a warning.
- **Deploys:** `deploy.sh` creates the file only if it is missing, so a deploy never resets it.

- **Settings:** `user-files/codex/config.toml` turns off Codex's own sandbox, because the container is the sandbox. It passes `GH_TOKEN` through to agent commands and excludes the other secrets. It also gives Codex the qmd and codegraph servers.
- **Approval reviewer:** the container home has no Codex rules files, so each escalated command, including a pipeline-helper push, goes to Codex's automatic approval reviewer. That reviewer trusts its security policy and `AGENTS.md`, not the role instructions. Since 2026-10-04 the config sets `[auto_review] policy`: Codex's default policy, copied verbatim, plus one section that marks the `pyrycode` organisation's repositories as trusted and authorises ticket-branch pushes and pull requests through the pipeline helper only. It replaces the whole default because Codex 0.159.2 drops `extra_policy` (openai/codex#50309). Codex reads the config at each agent spawn, so a change applies without a restart once it is in the home volume. The entrypoint reinstalls it from the image on start, so rebuild the image too.
- **Helpers:** the working-practice docs call the Mac's Codex helpers by absolute path, such as `/Users/juhanailmoniemi/.codex/bin/pyrycode-pipeline-action`, because Codex's approval rules match on exact paths. The image recreates those paths instead of forking the docs:
  - The helpers are copied into `user-files/codex-bin/` from the Mac's `~/.codex/bin`.
  - `/Users/juhanailmoniemi/Workspace/Projects` links to `/work/Projects`.
  - `/opt/homebrew/bin/gh` and `/opt/homebrew/bin/node` link to the image's own.
  - The publish folder is a real directory, because the helpers refuse to follow links into it.

  When the Mac's helpers change, copy them again and rebuild.

Verified 2026-10-04 in both containers: Codex answered a prompt, `gh` reached GitHub as the token's account, all codegraph and qmd tools were listed, and the helpers ran from their Mac paths.

## How it differs from the Mac

- **Secrets** come from Podman secrets, not from `op run`. `automation-access-shim` stands in for the 1Password helper so `bin/pyry-start` runs unchanged. The dispatcher loads `.env` itself.
- **Agents' GitHub login** is the dispatcher's token, passed as `GH_TOKEN`, which the dispatcher does not scrub from agent environments. git pushes through gh's credential helper. On the Mac, agents used the personal login in the Keychain. No login is stored on disk. The token carries the `read:org` scope among others, but it is still passed only as `GH_TOKEN`, never stored through `gh auth login`.
- **Secrets at rest:** Podman keeps secrets as plain files under the pyry account's home, so Pyry can read them. Accepted on 2026-10-04 as temporary; a safer arrangement is still open.
- **qmd** indexes only the fork's own docs, plus `pyrycode-docs` for desktop. On the Mac, agents could also search the personal vault and the other forks' docs.
- **User-level Claude files** are copies in `user-files/`: the shared git policy as `CLAUDE.md`, the `gh project item-list` guard hook, and `board-cards`. When the Mac originals change, update the copies and rebuild.

## qmd index refresh

`pyrycode-qmd-refresh.timer` checks every five minutes whether the pyrycode checkout's commit differs from the one last indexed, stored in `~/pyrycode-runtime/qmd-indexed-commit`. When it does, `pyrycode-qmd-refresh.sh` runs `qmd update` and repeats `qmd embed` inside the running dispatcher container until nothing is pending, then updates the stamp. Otherwise it does nothing. It only reads the checkout: the dispatcher fast-forwards it after each merge. Added 2026-10-04 so the documentation agent no longer rebuilds an index in its worktree. Install on pyrybox from the live agents checkout:

```bash
cp ~/pyrycode-runtime/work/Projects/pyrycode-agents/container/pyrycode-qmd-refresh.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pyrycode-qmd-refresh.timer
journalctl --user -u pyrycode-qmd-refresh
```

The service runs the script from the live checkout, so a merged change to it needs no reinstall. Because of it, `forks/pyrycode.env` sets `PYRY_SKIP_QMD_REFRESH=1`, so the pyrycode dispatcher no longer runs its own `qmd update && qmd embed` before each spawn (agent-dispatcher#115). The desktop container's own copy of `pyrycode-docs` is still refreshed only by its dispatcher before each spawn.

## Updating

- **Role instructions:** the entrypoint fast-forwards the agents checkout on every start, so a restart picks up merged changes to `main`.
- **Tool versions:** change the `ARG` lines in `Containerfile`, run `./deploy.sh`, then on pyrybox restart each running service.

## Builder live repairs

`pyrycode-dev-agents-token` arrives as `PYRY_DEV_AGENTS_TOKEN`. It is the separate service account that reads only the Dev agents vault. The dispatcher gives it only to builders as `OP_SERVICE_ACCOUNT_TOKEN`. The main Automation account never enters the container. The image includes the 1Password CLI so the targeted test launcher can fetch the Claude login in memory. Account credentials are removed from the test child after the fetch.

Add the restricted account reference to the Mac agents settings before running `push-secrets.sh`. Rebuild the image and install both updated container definitions. Restart each service once through systemd and wait for its graceful drain. Do not send a second stop signal. Confirm the restricted account is set by name only. Record a builder's nonzero executed and passed counts after rollout.
