# Tracked defaults and computer overrides

The fleet-runtime directory records non-secret defaults in the existing agents
repository. It adds no configuration service. Resolve one computer and project
with `python3 bin/build-runtime-record.py settings MACHINE PROJECT PRIVATE_OUTPUT`.
The output is a proposal for the protected configuration installer. Nothing is
copied to live configuration or applied automatically.

Fractal's Desktop override is PW_WORKERS=2. Desktop uses private per-run displays.
All computers retain one Mobile heavy run per host and admitted interactive heavy
work. The code-building agent limit remains one. Existing provider pacing stays
unchanged. No reserved Claude or Codex capacity is invented. The proposed idle
cache cap is 10 GiB. Change that tracked value before rollout if required.

Assumption awaiting Juhana: the Mac uses native-only admission until its restricted
account is demonstrated. The central machine ID is macbook in the 2026-10-15 operator log. Confirm
its current report before installation. Unknown computer names
refuse rather than silently dropping an override. Linux's isolated value records
the intended account policy and requires the isolation checks before adoption.

Assumption awaiting Juhana: backup scheduling starts every 300 seconds. This is an
asynchronous proposal. It does not promise a five-minute recovery point through
an outage. Destination storage and acceptable loss remain his decisions.

## Install one reviewed configuration

1. Review the resolved JSON against the existing private configuration. Apply
   projectHeavyLimits and unattendedPolicy to the matching central machine entry.
   Install the Desktop environment fields through the existing protected env
   loader. Keep separate displays enabled. Retain the previous private file for
   the approved rollback window. Never put credential values in this repository.
2. Route interactive heavy suites through agent-dispatcher 278. Apply the idle
   cache cap only inside its exclusive idle reservation. Do not clean beside an
   unmanaged build. The code-building agent count is the session policy, not a
   new provider admission limit.
3. Save image.txt, tools.txt and gates.txt in a private release-inventory directory.
   Use the immutable container image ID or exact native installation inventory.
   Record actual installed tool versions and the resolved gate configuration.
   Include the selected runtime acceptance command and required native service.
4. Generate the record with `python3 bin/build-runtime-record.py record INVENTORIES
   AGENTS_SHA TEST_DAEMON_SHA PRIVATE_OUTPUT`. Both revisions are exact 40-character
   source commits. This hashes exact inventory bytes. Keep inventories beside the
   release record. The tool never reads a secret environment or prints file data.
5. Configure PYRY_RUNTIME_RECORD_FILE to that protected output through the approved
   launcher configuration. Agent-dispatcher records its identifiers per run. A
   configured invalid record refuses startup. Do not invent a daemon revision to
   get past validation. Supply and test the actual installation revision.
6. Run disposable runtime acceptance through existing exclusive admission. Check
   unattended startup, confirmed child cleanup and the required platform service
   under the execution account. Store its bounded result in existing evidence.
   Complete the guarded release only after exact acknowledgements and acceptance.

These settings do not change a dispatcher submodule pin, image, target, service,
account or token. Merge is separate from installation. Apply the controller's
native policy and evidence metadata support before activating the resolved
configuration. Rollback disables new adoption first and preserves active work.

CODEOWNERS assigns the existing human account ilmoniemi to every agents file. It
requires the separately approved review and update-owner rulesets to enforce that
ownership. The current bootstrap PR author cannot self-approve. Complete the
approved bootstrap merges or arrange another qualified human before activation.
