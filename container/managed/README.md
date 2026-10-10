# One host manager for the project containers

These files opt both existing containers into the shared machine manager.
Nothing in `deploy.sh` installs them. The normal container definitions remain
independent until the generated managed units are installed during an authorised rollout.
Podman 4.9 on pyrybox silently ignores Quadlet container drop-ins, so
`render-units.py` creates complete units from the current base definitions.

The manager runs as the host's `pyry` user. Each container mounts the same
private socket directory read-only and authenticates with its own project
token. Neither container needs host networking or a published port. The
existing shared 16 GB memory ceiling and container CPU settings still apply.
The separate qmd indexing container keeps its existing two-CPU cap and low
priority. It does not consume an agent place.

## Prepare before rollout

1. Merge the shared dispatcher and consumer changes. Fast-forward the stopped
   consumer checkouts on main and initialise their dispatcher submodules.
   The host manager uses the core consumer's dispatcher code and Linux
   dependencies. Verify its `node_modules/tsx/dist/loader.mjs` exists.
2. Set up the central claim service using the shared dispatcher's
   `docs/machine-manager.md`. Keep its database on local disk. The sample
   `claimsUrl` assumes a service or private SSH tunnel at host loopback port
   7430. Set it to the actual private endpoint before starting the manager.
3. Create `~/pyrycode-runtime/fleet` with mode 0700. Copy `manager.json` there.
   Set project order explicitly. The sample lists core before Desktop and
   includes only the two projects currently containerised on pyrybox.
4. Provision four distinct credentials in
   `~/pyrycode-runtime/fleet/manager.env`, mode 0600, through the configured
   password-manager mechanism. Do not paste values into chat or logs:

   ```text
   FLEET_PYRYBOX_TOKEN=...
   FLEET_LOCAL_OPERATOR_TOKEN=...
   FLEET_CORE_TOKEN=...
   FLEET_DESKTOP_TOKEN=...
   ```

   The machine token must match the central claim service's pyrybox entry.
   The other tokens belong only to this manager. Copy the core token into
   the Podman secret `pyrycode-manager-token` and the Desktop token into
   `pyrycode-desktop-manager-token`, using stdin to `podman secret create`.
   The dispatcher removes its manager token from spawned agents' environments.
   The operator and machine tokens never enter project containers.
5. Verify the Node path in `pyry-fleet-manager.service`. The checked pyrybox
   host has Node 24.13.0 at that path. Copy the service to
   `~/.config/systemd/user/`. Do not start it yet.
6. Render complete container definitions into a new staging directory:

   ```bash
   python3 render-units.py ~/pyrycode-runtime/managed-units
   ```

   Re-render from the current base units whenever their settings change. The
   renderer refuses to overwrite an existing staging directory. Validate them
   without installation using `QUADLET_UNIT_DIRS`:

   ```bash
   QUADLET_UNIT_DIRS="$HOME/pyrycode-runtime/managed-units" \
     /usr/libexec/podman/quadlet -user -dryrun
   ```

   Each generated command must contain `run --managed`, the socket mount,
   the Unix manager URL and the matching project secret. Check this against
   the installed Podman generator with:

   ```bash
   python3 verify-units.py ~/pyrycode-runtime/managed-units
   ```
7. Disable independent watcher takeover. Read-only monitoring can remain.
   A repair started outside a managed dispatcher does not acquire capacity
   or obey ticket ownership. Manual test jobs have the same limitation.

The `socket` directory must stay in place across manager restarts. Its
contents can change, but replacing the directory would leave running
containers mounted on the old directory. The service creates it with mode
0700 and removes only its old socket before starting. Only this service may
own that socket path. Each socket is mode 0600. The existing `keep-id` user
mapping lets the containers connect as the same host user.

## Roll out

Run these on pyrybox only after all preparation is complete. Stopping the
dispatchers drains their active agents. Wait for both stops to finish and
do not send a second stop signal.

```bash
systemctl --user stop pyrycode-dispatcher pyrycode-desktop-dispatcher

# Save the independent definitions in a NEW directory before replacing them.
install -d -m 0700 ~/pyrycode-runtime/fleet/independent-units
cp -n ~/.config/containers/systemd/pyrycode-dispatcher.container \
  ~/.config/containers/systemd/pyrycode-desktop-dispatcher.container \
  ~/pyrycode-runtime/fleet/independent-units/
install -m 0644 ~/pyrycode-runtime/managed-units/*.container \
  ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start pyry-fleet-manager
systemctl --user start pyrycode-dispatcher pyrycode-desktop-dispatcher
```

The generated units request the manager at boot, enforce `--managed`, and supply the
socket URL and project credential. Missing credentials or a missing manager
cannot fall back to independent dispatch. `Wants` starts the manager without
coupling container lifetime to its restart. Already admitted jobs can finish
while the manager is unavailable. Their reservations remain occupied until
completion is acknowledged.

Verify both project reports in manager status and the shared 1-heavy,
2-combined limits. Check that each generated container command has the
socket mount, correct secret and `run --managed`. Do not start another
dispatcher for the same project on this host.

## Recovery and rollback

A killed container leaves its tickets and capacity reserved. Disable its
automatic restart and confirm its child processes are gone. Free each
affected ticket with the central operator's `free` command and its current
generation, using `--confirmed-stopped`. Keep working copies intact. A new
dispatcher session cannot adopt an old session's grants. A recent old
session can reject registration for up to three minutes; restarting the
manager clears those offers while preserving reservations.

For rollback, drain all managed dispatchers sharing the affected boards
first. Stop the pyrybox containers, restore the saved independent container
definitions, and reload systemd. Resume independent dispatch
only after restoring one dispatcher per board across the whole fleet.
Never erase the claim database to clear a stuck ticket.

## Isolated verification

The shared dispatcher includes `scripts/fleet-container-smoke.mjs`. Compile
with `pnpm exec tsc`, then run it with Node on Linux in `host` mode. It uses
the existing runtime image, temporary state and uniquely named containers.
No production home, worktree, credential or board is mounted. Each fake
worker has no network, a read-only root filesystem, 128 MB of memory and a
quarter-CPU cap. Child jobs sleep until released.

The test checks shared capacity, light work, a global documentation lock,
manager restart through the mounted socket directory, container loss,
manual release, and replacement-session safety. For a real second computer,
set `FLEET_TEST_PORT` and `FLEET_TEST_PEER=1` on Linux, forward that loopback
port over SSH, then run the script's `peer URL` mode on the second computer
when Linux prints `PEER_READY`. Test-only credentials are built into the
script. They must never be used for deployment. The harness removes only
its own containers and retains temporary evidence for review.
