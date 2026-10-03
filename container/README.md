# Dispatcher container

Runs this fork's dispatcher, and every agent it spawns, inside a rootless Podman container on pyrybox instead of on the Mac. Decided 2026-10-03: the Mac's CPU was shared with the mobile pipeline's Gradle builds and test emulators, and the verifier gate kept timing out under that load. Any OCI engine builds the image, so the runtime can move to another Linux machine later.

## What runs where

| Piece | Where |
|---|---|
| Image | `localhost/pyrycode-agent-runtime:latest`, built on pyrybox from this folder |
| Repositories and worktrees | `~/pyrycode-runtime/work` on pyrybox, mounted at `/work` |
| Claude state, transcripts, Go and qmd caches, gh login | `~/pyrycode-runtime/home`, mounted at `/home/agent` |
| Settings | `~/pyrycode-runtime/config/dispatcher.env`, a copy of `dispatcher.env` |
| Secrets | Podman secrets `pyrycode-github-token`, `pyrycode-claude-token`, `pyrycode-discord-webhook` |
| Service | `pyrycode-dispatcher.container`, a Quadlet unit run by the pyry account's systemd user manager |

The container runs with `--userns=keep-id`, so it has exactly the pyry account's rights and every file it writes belongs to pyry. It gets six of the eight CPU threads and 24 GB of memory, which leaves room for Pyry.

## Steps

All commands below run on the Mac from this folder unless marked pyrybox.

1. **Build:** `./deploy.sh`. It copies this folder, builds the image and prints tool versions. It starts nothing.
2. **Secrets:** `./push-secrets.sh`. It reads the three `op://` references from the Mac agents repo's `.env` and stores the values as Podman secrets on pyrybox.
3. **Provision and smoke test** (pyrybox). The first run clones both repositories and builds the qmd and codegraph indexes on the CPU, which can take a long time:
   ```bash
   podman run --rm --init --userns=keep-id \
     -v ~/pyrycode-runtime/work:/work -v ~/pyrycode-runtime/home:/home/agent \
     -v ~/pyrycode-runtime/config:/config:ro \
     --secret pyrycode-github-token,type=env,target=GITHUB_TOKEN \
     --secret pyrycode-claude-token,type=env,target=CLAUDE_CODE_OAUTH_TOKEN \
     --secret pyrycode-discord-webhook,type=env,target=DISCORD_WEBHOOK_URL \
     localhost/pyrycode-agent-runtime:latest smoke
   ```
4. **Switch over.** Only one dispatcher may watch board 1:
   1. Mac: drain the Mac dispatcher with `bin/pyry-drain` in the agents repo and wait until it exits.
   2. pyrybox: install and start the service:
      ```bash
      mkdir -p ~/.config/containers/systemd
      cp ~/pyrycode-runtime/build/pyrycode-dispatcher.container ~/.config/containers/systemd/
      systemctl --user daemon-reload
      systemctl --user start pyrycode-dispatcher
      journalctl --user -u pyrycode-dispatcher -f
      ```
5. **Roll back** (pyrybox): `systemctl --user stop pyrycode-dispatcher`, which drains first, then remove the unit file and run `systemctl --user daemon-reload`. After that, start `bin/pyry-start` on the Mac again.

## How it differs from the Mac

- **Secrets** come from Podman secrets, not from `op run`. `automation-access-shim` stands in for the 1Password helper so `bin/pyry-start` runs unchanged. The dispatcher loads `.env` itself.
- **Agents' GitHub login** is the dispatcher's token, which the entrypoint stores as gh's login on every start. On the Mac, agents used the personal login in the Keychain. The stored copy is a plain file under `~/pyrycode-runtime/home/.config/gh`, readable by the pyry account.
- **qmd** indexes only this repository: `pyrycode-docs` and `pyrycode-root`. On the Mac, agents could also search the personal vault and the other forks' docs.
- **No Figma MCP.** It needs an interactive OAuth login, and this fork's agents do not use it.
- **User-level Claude files** are copies in `user-files/`: the shared git policy as `CLAUDE.md`, the `gh project item-list` guard hook, and `board-cards`. When the Mac originals change, update the copies and rebuild.

## Updating

- **Role instructions:** the entrypoint fast-forwards the agents checkout on every start, so a restart picks up merged changes to `main`.
- **Tool versions:** change the `ARG` lines in `Containerfile`, run `./deploy.sh`, then on pyrybox run `systemctl --user restart pyrycode-dispatcher`.
