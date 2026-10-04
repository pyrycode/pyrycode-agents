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

Both use the same three Podman secrets: `pyrycode-github-token`, `pyrycode-claude-token`, `pyrycode-discord-webhook`. The forks share `/work` so the desktop container can index pyrycode's docs, which its roles search for cross-project lessons. Each fork has its own home, because Claude rewrites `~/.claude.json` and two containers must not share it.

Containers run with `--userns=keep-id`, so they have exactly the pyry account's rights and every file they write belongs to pyry. Each may use six of the eight CPU threads; when both pipelines run gates at once, they share the CPU. Memory is capped at 16 GB for both together, by the systemd user slice `pyrycode-agents.slice` that both units run in. That leaves about half of pyrybox's 31 GB to Pyry and the system. Ad-hoc `podman run` commands sit outside the slice, so give them `--memory=16g` themselves.

## Steps

All commands below run on the Mac from this folder unless marked pyrybox.

1. **Build:** `./deploy.sh`. It copies this folder, installs both settings files, builds the image and prints tool versions. It starts nothing.
2. **Secrets:** `./push-secrets.sh`. It reads the three `op://` references from the Mac pyrycode agents repo's `.env` and stores the values as Podman secrets on pyrybox. Both forks use the same references.
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
- **Daemon for the real-claude specs:** `PYRY_BIN` is the image's pinned pyry. On the Mac it was a hand-built v0.29.0.
- **Figma:** desktop UI tickets need it, and the builder stops a UI ticket as blocked without it. The plugin is installed, but it needs a one-time interactive OAuth login before its tools work. Not solved yet.

## Codex runner

The image includes Codex, so a dispatcher can run with `--runner codex` or `PYRY_AGENT_RUNNER=codex`. Codex logs in with a ChatGPT account, not a token, so it needs a one-time device login of its own per home folder. Do not copy the Mac's `~/.codex/auth.json`: two machines refreshing one login can sign the Mac out. On pyrybox:

```bash
podman run --rm -it --userns=keep-id -v ~/pyrycode-runtime/home:/home/agent \
  localhost/pyrycode-agent-runtime:latest codex-login
```

It prints a URL and a code to approve in a browser on any device. The login is stored in the home folder's `.codex/auth.json`, readable by the pyry account like the other secrets. The container's Codex settings in `user-files/codex/config.toml` turn off Codex's own sandbox, because the container is the sandbox, and pass `GH_TOKEN` through to agent commands while excluding the other secrets. The Mac-only Codex helper scripts under `~/.codex/bin` are not in the image.

## How it differs from the Mac

- **Secrets** come from Podman secrets, not from `op run`. `automation-access-shim` stands in for the 1Password helper so `bin/pyry-start` runs unchanged. The dispatcher loads `.env` itself.
- **Agents' GitHub login** is the dispatcher's token, passed as `GH_TOKEN`, which the dispatcher does not scrub from agent environments. git pushes through gh's credential helper. On the Mac, agents used the personal login in the Keychain. No login is stored on disk. The token cannot be stored as a gh login anyway, because it lacks the `read:org` scope that `gh auth login` validates.
- **Secrets at rest:** Podman keeps secrets as plain files under the pyry account's home, so Pyry can read them. Accepted on 2026-10-04 as temporary; a safer arrangement is still open.
- **qmd** indexes only the fork's own docs, plus `pyrycode-docs` for desktop. On the Mac, agents could also search the personal vault and the other forks' docs.
- **User-level Claude files** are copies in `user-files/`: the shared git policy as `CLAUDE.md`, the `gh project item-list` guard hook, and `board-cards`. When the Mac originals change, update the copies and rebuild.

## Updating

- **Role instructions:** the entrypoint fast-forwards the agents checkout on every start, so a restart picks up merged changes to `main`.
- **Tool versions:** change the `ARG` lines in `Containerfile`, run `./deploy.sh`, then on pyrybox restart each running service.
