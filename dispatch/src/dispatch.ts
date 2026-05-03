import { execSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

import { GitHubProjectClient } from "./github.js";
import { AGENTS, type AgentConfig, type ProjectItem } from "./types.js";
import {
  AUTO_ADVANCE_RULES,
  AGENT_COLUMN_MAP,
  MANUAL_ADVANCE_GATES,
  MID_PIPELINE_COLUMNS,
  resolveAgentsRepoRoot,
  resolvePyrycodeRepoRoot,
  shouldSkipDispatch,
  isPipelineLabel,
  isPipelineInFlight,
  decideAutoAdvance,
  decideReworkRoutes,
  decideDoneCleanup,
  shouldAutoCommit,
  shouldUseWorktree,
  hasOpenBlockers,
  shouldSkipBlockedFor,
  extractReworkCount,
  REWORK_LOOP_THRESHOLD,
  maxTurnsFor,
  shouldAttemptSafeSalvage,
} from "./lib.js";

// Load .env from agents repo root (where dispatch lives).
// __dirname is agents/dispatch/src, so ../.. is agents/ root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsRepoRoot = resolveAgentsRepoRoot(__dirname);

// The main pyrycode/pyrycode repo — where code lives and agents work.
const repoRoot = process.env.PYRYCODE_REPO_PATH
  ? resolve(process.env.PYRYCODE_REPO_PATH)
  : resolvePyrycodeRepoRoot(agentsRepoRoot);

config({ path: resolve(agentsRepoRoot, ".env") });

// Validate required environment variables
const REQUIRED_ENV = ["GITHUB_OWNER", "GITHUB_REPO", "PROJECT_NUMBER", "GITHUB_TOKEN"] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}. Check .env file.`);
    process.exit(1);
  }
}
if (isNaN(parseInt(process.env.PROJECT_NUMBER!, 10))) {
  console.error(`PROJECT_NUMBER must be a number, got: "${process.env.PROJECT_NUMBER}"`);
  process.exit(1);
}

// Discord notifications
async function notifyDiscord(message: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (error) {
    console.error(`Discord notification failed: ${error}`);
  }
}

// Agent run logs
const LOGS_DIR = resolve(agentsRepoRoot, "dispatch/logs");
mkdirSync(LOGS_DIR, { recursive: true });

function agentLogPath(agent: string, issueNumber: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(LOGS_DIR, `${timestamp}_${agent}_#${issueNumber}.log`);
}

function writeLog(logFile: string, section: string, content: string): void {
  const header = `\n${"=".repeat(60)}\n${section} — ${new Date().toISOString()}\n${"=".repeat(60)}\n`;
  appendFileSync(logFile, header + content + "\n");
}

// --- Claude CLI streaming helper ---
// Uses --output-format stream-json to get real-time turn-by-turn output.
// Each assistant message, tool call, and result is logged as it happens,
// so agent runs are observable during execution (not just post-mortem).

interface StreamResult {
  output: string;
  sessionId: string;
  isError: boolean;
  numTurns: number;
  totalCostUsd: number;
  durationMs: number;
  usage: Record<string, unknown>;
  terminalReason: string;
  rawResult: Record<string, unknown>;
}

function logStreamMessage(logFile: string, msg: Record<string, unknown>): void {
  const ts = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  switch (msg.type) {
    case "system": {
      appendFileSync(logFile, `[${ts}] 🔧 Session initialized (${(msg as any).session_id || "?"})\n`);
      break;
    }
    case "assistant": {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use") {
            const inputPreview = JSON.stringify(block.input || {}).slice(0, 300);
            appendFileSync(logFile, `[${ts}] 🔧 ${block.name}: ${inputPreview}\n`);
          } else if (block.type === "text" && block.text) {
            const preview = block.text.replace(/\n/g, " ").slice(0, 200);
            appendFileSync(logFile, `[${ts}] 💬 ${preview}\n`);
          }
        }
      }
      break;
    }
    case "result": {
      const r = msg as any;
      appendFileSync(logFile, `[${ts}] 🏁 ${r.subtype} | Turns: ${r.num_turns} | Cost: $${(r.total_cost_usd || 0).toFixed(2)} | Session: ${r.session_id || "?"}\n`);
      break;
    }
    default: {
      // Log unknown message types with a compact preview
      appendFileSync(logFile, `[${ts}] [${String(msg.type)}] ${JSON.stringify(msg).slice(0, 300)}\n`);
    }
  }
}

function runClaudeStreaming(opts: {
  promptFile: string;
  systemPromptFile: string;
  model: string;
  effort: string;
  maxTurns: number;
  allowedTools: string;
  cwd: string;
  timeoutMs: number;
  logFile: string;
  env: NodeJS.ProcessEnv;
}): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c",
      `cat "${opts.promptFile}" | claude -p --verbose --output-format stream-json --model ${opts.model} --effort ${opts.effort} --max-turns ${opts.maxTurns} --allowedTools "${opts.allowedTools}" --append-system-prompt-file "${opts.systemPromptFile}"`
    ], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let buffer = "";
    let resultMsg: Record<string, unknown> | null = null;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      appendFileSync(opts.logFile, `\n⏰ TIMEOUT — killing agent after ${opts.timeoutMs / 1000}s\n`);
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          logStreamMessage(opts.logFile, msg);
          if (msg.type === "result") resultMsg = msg;
        } catch {
          appendFileSync(opts.logFile, `[stream] ${line.slice(0, 500)}\n`);
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer);
          logStreamMessage(opts.logFile, msg);
          if (msg.type === "result") resultMsg = msg;
        } catch { /* partial JSON, already logged via stream */ }
      }

      if (resultMsg) {
        const r = resultMsg as any;
        resolve({
          output: r.result || "",
          sessionId: r.session_id || "",
          isError: r.is_error || false,
          numTurns: r.num_turns || 0,
          totalCostUsd: r.total_cost_usd || 0,
          durationMs: r.duration_ms || 0,
          usage: r.usage || {},
          terminalReason: r.terminal_reason || "",
          rawResult: r,
        });
      } else if (timedOut) {
        reject(new Error(`Agent timed out after ${opts.timeoutMs / 1000}s`));
      } else {
        reject(new Error(`Claude CLI exited with code ${code}, no result message received`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// State file to persist across restarts
// Dispatch state is tracked entirely via GitHub labels (ready:<agent>, needs-rework:<agent>).
// No local state file needed — all state is visible on the ticket itself.

async function buildPromptForAgent(
  agent: AgentConfig,
  item: ProjectItem,
  specRoot: string,
): Promise<string> {
  const parts: string[] = [];

  parts.push(`# Ticket #${item.issueNumber}: ${item.title}`);
  parts.push(`\nURL: ${item.url}`);
  parts.push(`\n## Issue Body\n${item.body}`);

  // Gather context from previous phases
  const ticketNum = item.issueNumber;

  // Architecture docs — needed by developer, code-review, documentation.
  const needsArchDoc = !["po"].includes(agent.name);
  if (needsArchDoc) {
    try {
      const archFiles = execSync(`ls docs/specs/architecture/${ticketNum}-* 2>/dev/null || true`, {
        cwd: specRoot, encoding: "utf-8",
      }).trim();
      if (archFiles) {
        for (const file of archFiles.split("\n")) {
          parts.push(`\n## Architecture Doc (from System Architect)\n${readFileSync(resolve(specRoot, file), "utf-8")}`);
        }
      }
    } catch (e) {
      console.warn(`   ⚠️  Failed to read architecture docs for #${ticketNum}: ${e}`);
    }
  }

  // Selective context injection — only give agents the upstream context they need.
  // Review findings are primarily for the developer (rework).
  const needsCodeReview = ["developer"].includes(agent.name);

  // Check for code review (file-based, overwritten each run)
  if (needsCodeReview) {
    try {
      if (existsSync(resolve(specRoot, `docs/specs/code-reviews/${ticketNum}-review.md`))) {
        parts.push(
          `\n## Code Review Findings\n${readFileSync(resolve(specRoot, `docs/specs/code-reviews/${ticketNum}-review.md`), "utf-8")}`
        );
      }
    } catch (e) {
      console.warn(`   ⚠️  Failed to read code review for #${ticketNum}: ${e}`);
    }
  }

  // Look up open PR for agents that need it (code-review)
  const needsPr = ["code-review"].includes(agent.name);
  if (needsPr && ticketNum > 0) {
    try {
      const prJson = execSync(
        `gh pr list --head feature/${ticketNum} --state open --json number,url --jq '.[0]'`,
        { cwd: repoRoot, encoding: "utf-8" }
      ).trim();
      if (prJson) {
        const pr = JSON.parse(prJson);
        parts.push(`\n## Pull Request\nPR #${pr.number}: ${pr.url}\nBranch: feature/${ticketNum}`);
      } else {
        parts.push(`\n## Pull Request\nNo open PR found for branch feature/${ticketNum}. Check with: gh pr list --head feature/${ticketNum}`);
      }
    } catch (e) {
      console.warn(`   ⚠️  Failed to look up PR for #${ticketNum}: ${e}`);
      parts.push(`\n## Pull Request\nCould not determine PR number. Find it with: gh pr list --head feature/${ticketNum}`);
    }
  }

  // PO rework: include issue comments so the PO can see upstream splitting guidance
  if (agent.name === "po" && ticketNum > 0) {
    try {
      const commentsJson = execSync(
        `gh issue view ${ticketNum} --json comments --jq '.comments[].body'`,
        { cwd: repoRoot, encoding: "utf-8", timeout: 15_000 }
      ).trim();
      if (commentsJson) {
        parts.push(`\n## Previous Agent Comments\n${commentsJson}`);
      }
    } catch (e) {
      console.warn(`   ⚠️  Failed to fetch comments for #${ticketNum}: ${e}`);
    }
  }

  // Add specific instructions based on agent role
  switch (agent.name) {
    case "po":
      if (ticketNum > 0) {
        parts.push("\n## Your Task\nThis ticket was routed back to you for rework. Read the issue body and the previous agent comments above to understand what needs to change. Common reasons:\n- **Ticket too large**: Split into smaller, independently deliverable tickets. Create sub-tickets and close this one.\n- **Unclear acceptance criteria**: Rewrite the criteria to be specific and testable.\n- **Missing context**: Add the missing information.\n\nAfter making changes, add label `ready:po`.");
      } else {
        parts.push("\n## Your Task\nCreate a well-structured GitHub issue from the above request.");
      }
      break;
    case "architect":
      parts.push("\n## Your Task\nCreate a Go architecture document for this feature. Define interfaces, data flows, concurrency patterns. Save to docs/specs/architecture/");
      break;
    case "developer":
      parts.push("\n## Your Task\nImplement this feature in Go following the architecture doc above. Run `go test -race ./...` and `go vet ./...` before creating a PR.");
      break;
    case "code-review":
      parts.push("\n## Your Task\nReview the PR for Go quality, idioms, and correctness. Use `gh pr diff <number>` to read the diff.");
      break;
    case "documentation":
      parts.push("\n## Your Task\nSynthesize all ticket artifacts into the project knowledge base. Write or update feature docs in docs/knowledge/features/, create ADRs in docs/knowledge/decisions/ if significant decisions were made, and update docs/knowledge/INDEX.md.");
      break;
  }

  return parts.join("\n");
}

/**
 * Run the safer-salvage path on a max_turns failure: gate on clean
 * vet/build + uncommitted changes (via `shouldAttemptSafeSalvage`),
 * then commit the work, push, open a DRAFT PR, label the ticket
 * `error:max_turns_salvaged`, and post a triage comment.
 *
 * Returns true if salvage was performed (caller should skip the
 * normal error path AND the success-path labeling); false otherwise
 * (caller falls through to the throw, agent gets `error:<name>`).
 *
 * Distinct from the existing PR-already-exists salvage that lives
 * inline in dispatchToAgent. That one fires when the agent finished
 * the work and ran out of turns on PR-creation cleanup; this one
 * fires when the agent stopped mid-work but has buildable code.
 */
async function attemptSaferSalvage(opts: {
  agentCwd: string;
  branchName: string;
  agent: AgentConfig;
  item: ProjectItem;
  streamResult: StreamResult;
  client: GitHubProjectClient;
  logFile: string;
}): Promise<boolean> {
  try {
    const dirty = execSync(`git status --porcelain`, {
      cwd: opts.agentCwd, encoding: "utf-8", timeout: 15_000,
    }).toString();

    let vetExitCode = 0;
    try { execSync(`go vet ./...`, { cwd: opts.agentCwd, stdio: "pipe", timeout: 60_000 }); }
    catch (e: any) { vetExitCode = typeof e.status === "number" ? e.status : 1; }

    let buildExitCode = 0;
    try { execSync(`go build ./...`, { cwd: opts.agentCwd, stdio: "pipe", timeout: 120_000 }); }
    catch (e: any) { buildExitCode = typeof e.status === "number" ? e.status : 1; }

    if (!shouldAttemptSafeSalvage({
      terminalReason: opts.streamResult.terminalReason || "",
      prAlreadyExists: false,
      gitStatusOutput: dirty,
      vetExitCode,
      buildExitCode,
    })) {
      writeLog(opts.logFile, "SAFER_SALVAGE_SKIPPED",
        `gates: vet=${vetExitCode} build=${buildExitCode} dirty=${dirty.trim().length > 0}`);
      return false;
    }

    execSync(`git add -A`, { cwd: opts.agentCwd, stdio: "pipe", timeout: 15_000 });
    // spawnSync with argv (no shell) so commit messages and branch
    // names containing shell metacharacters can't break the call.
    // The same pattern is used for `gh pr create` below where the
    // ticket title (user-influenced text) flows in.
    const commitResult = spawnSync(
      "git",
      [
        "commit",
        "-m", `WIP: max_turns salvage for #${opts.item.issueNumber}`,
        "-m", `Auto-committed by dispatcher when ${opts.agent.name} hit max_turns. Build was clean (vet + build); work preserved as draft PR for human triage.`,
        "-m", `Session: ${opts.streamResult.sessionId}`,
      ],
      { cwd: opts.agentCwd, stdio: "pipe", timeout: 15_000 },
    );
    if (commitResult.status !== 0) {
      throw new Error(`git commit failed: ${commitResult.stderr?.toString() || "unknown"}`);
    }

    const pushResult = spawnSync(
      "git", ["push", "-u", "origin", opts.branchName],
      { cwd: opts.agentCwd, stdio: "pipe", timeout: 30_000 },
    );
    if (pushResult.status !== 0) {
      throw new Error(`git push failed: ${pushResult.stderr?.toString() || "unknown"}`);
    }

    const tail = (opts.streamResult.output || "").slice(-2500);
    const prBody = [
      `## Auto-salvaged from \`max_turns\``,
      ``,
      `The **${opts.agent.name}** agent hit \`max_turns\` (${opts.streamResult.numTurns} turns, $${opts.streamResult.totalCostUsd.toFixed(2)}) on #${opts.item.issueNumber} while work was in progress. The dispatcher auto-committed the uncommitted changes and opened this **draft** PR for human triage.`,
      ``,
      `**Build status at salvage:** clean (\`go vet\` + \`go build\` both passed). Tests were not run as a salvage gate — failing tests are often the signal the agent was chasing.`,
      ``,
      `**Last messages from the agent (may include unresolved findings):**`,
      ``,
      `\`\`\``,
      tail,
      `\`\`\``,
      ``,
      `**To investigate:**`,
      `- Resume the session: \`claude --resume ${opts.streamResult.sessionId}\``,
      `- Branch: \`${opts.branchName}\``,
      `- Issue: ${opts.item.url}`,
      ``,
      `This PR is a **draft** — auto-merge is disabled until a reviewer marks it ready (or closes it). Ticket label \`error:max_turns_salvaged\` indicates triage required.`,
    ].join("\n");

    const prResult = spawnSync(
      "gh",
      [
        "pr", "create", "--draft",
        "--title", `[max_turns] ${opts.item.title}`,
        "--head", opts.branchName,
        "--base", "main",
        "--body-file", "-",
      ],
      { cwd: opts.agentCwd, stdio: ["pipe", "pipe", "pipe"], input: prBody, timeout: 30_000 },
    );
    if (prResult.status !== 0) {
      throw new Error(`gh pr create failed: ${prResult.stderr?.toString() || "unknown"}`);
    }

    try { await opts.client.addLabel(opts.item.issueNumber, "error:max_turns_salvaged"); }
    catch (e) { console.warn(`   ⚠️  Failed to add error:max_turns_salvaged label: ${e}`); }

    try {
      await opts.client.addComment(
        opts.item.issueNumber,
        `## ⚠️ Salvaged from \`max_turns\`\n\nThe ${opts.agent.name} agent hit max_turns at ${opts.streamResult.numTurns} turns ($${opts.streamResult.totalCostUsd.toFixed(2)}) but had clean uncommitted work. The dispatcher auto-committed the changes and opened a draft PR for human triage.\n\nLabel \`error:max_turns_salvaged\` is set; the ticket does **not** auto-advance.\n\n**Reviewer:** check the draft PR — decide whether to fix-and-promote (mark ready), recover via JSONL replay, or close as wontfix.`,
      );
    } catch (e) { console.warn(`   ⚠️  Failed to post salvage comment: ${e}`); }

    writeLog(opts.logFile, "SAFER_SALVAGE",
      `Committed + pushed + draft PR opened for #${opts.item.issueNumber} (${opts.streamResult.numTurns} turns, $${opts.streamResult.totalCostUsd.toFixed(2)})`);
    console.log(`   💾 Safer salvage: draft PR opened for #${opts.item.issueNumber}, label error:max_turns_salvaged set`);

    await notifyDiscord(`💾 **${opts.agent.name}** salvaged on #${opts.item.issueNumber}: ${opts.item.title}\n${opts.item.url}\nDraft PR opened — needs human triage.`);
    return true;
  } catch (e) {
    console.warn(`   ⚠️  Safer salvage attempt failed: ${e}`);
    writeLog(opts.logFile, "SAFER_SALVAGE_FAILED", String(e));
    return false;
  }
}

async function dispatchToAgent(
  agent: AgentConfig,
  item: ProjectItem,
  client: GitHubProjectClient,
): Promise<void> {
  const startTime = Date.now();
  const startTs = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  console.log(`\n[${startTs}] 🚀 Dispatching #${item.issueNumber} to ${agent.name}`);
  console.log(`   Title: ${item.title}`);

  const branchName = `feature/${item.issueNumber}`;

  // --- Branch + worktree setup ---
  // Main repo NEVER checks out the feature branch — avoids orphaned untracked files
  // when switching back to main. All feature branch work happens in the worktree.
  const worktreeDir = resolve(repoRoot, `../.pyrycode-worktrees/${agent.name}-${item.issueNumber}`);
  // PO never needs a worktree — it uses gh CLI, no code changes
  const useWorktree = item.issueNumber > 0 && shouldUseWorktree(agent);
  const agentCwd = useWorktree ? worktreeDir : repoRoot;

  // PO and issue-0 (manual dispatch) run on main — just pull latest
  if (!useWorktree) {
    try {
      execSync(`git checkout main && git pull`, { cwd: repoRoot, stdio: "pipe" });
    } catch (e) {
      console.warn(`   ⚠️  Failed to update main: ${e}`);
    }
  } else {
    // Pull latest main and fetch remote branches
    try {
      execSync(`git checkout main && git pull`, { cwd: repoRoot, stdio: "pipe" });
      execSync(`git fetch origin`, { cwd: repoRoot, stdio: "pipe" });
    } catch (e) {
      console.error(`   ⚠️  Failed to update main: ${e}`);
      await client.addComment(item.issueNumber, `## ⚠️ Dispatch Error: ${agent.name}\n\nFailed to update main branch. Manual intervention required.\n\n\`\`\`\n${e}\n\`\`\``);
      try { await client.addLabel(item.issueNumber, `error:${agent.name}`); } catch {}
      return;
    }

    // Create/update the feature branch ref WITHOUT checking it out in the main repo
    const localExists = (() => {
      try {
        execSync(`git rev-parse --verify ${branchName}`, { cwd: repoRoot, stdio: "pipe" });
        return true;
      } catch { return false; }
    })();
    const remoteExists = (() => {
      try {
        execSync(`git rev-parse --verify origin/${branchName}`, { cwd: repoRoot, stdio: "pipe" });
        return true;
      } catch { return false; }
    })();

    try {
      if (localExists) {
        console.log(`   📌 Reusing local branch ${branchName}`);
      } else if (remoteExists) {
        execSync(`git branch ${branchName} origin/${branchName}`, { cwd: repoRoot, stdio: "pipe" });
        console.log(`   📌 Recovered branch ${branchName} from origin`);
      } else {
        execSync(`git branch ${branchName} main`, { cwd: repoRoot, stdio: "pipe" });
        console.log(`   🌿 Created branch ${branchName}`);
      }
    } catch (e) {
      console.error(`   ❌ Git branch setup failed: ${e}`);
      await client.addComment(item.issueNumber, `## ⚠️ Dispatch Error: ${agent.name}\n\nFailed to set up branch \`${branchName}\`. Manual intervention required.\n\n\`\`\`\n${e}\n\`\`\``);
      try { await client.addLabel(item.issueNumber, `error:${agent.name}`); } catch {}
      return;
    }

    // Create worktree from the feature branch
    try {
      // Clean up stale worktree if it exists from a previous failed run
      try {
        execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: repoRoot, stdio: "pipe" });
      } catch {}
      mkdirSync(resolve(repoRoot, `../.pyrycode-worktrees`), { recursive: true });
      execSync(`git worktree add "${worktreeDir}" ${branchName}`, { cwd: repoRoot, stdio: "pipe" });
      console.log(`   🌳 Created worktree at ${worktreeDir}`);
    } catch (e) {
      console.error(`   ❌ Failed to create worktree: ${e}`);
      await client.addComment(item.issueNumber, `## ⚠️ Dispatch Error: ${agent.name}\n\nFailed to create git worktree.\n\n\`\`\`\n${e}\n\`\`\``);
      try { await client.addLabel(item.issueNumber, `error:${agent.name}`); } catch {}
      return;
    }

    // Merge main into the feature branch INSIDE the worktree (not in the main repo)
    try {
      execSync(`git merge main --no-edit`, { cwd: worktreeDir, stdio: "pipe" });
      console.log(`   🔀 Merged main into ${branchName} (in worktree)`);
    } catch (e) {
      try { execSync(`git merge --abort`, { cwd: worktreeDir, stdio: "pipe" }); } catch {}
      console.error(`   ❌ Merge conflict merging main into ${branchName}: ${e}`);
      await client.addComment(item.issueNumber, `## ⚠️ Dispatch Error: ${agent.name}\n\nMerge conflict on branch \`${branchName}\` when merging main. Manual resolution required.\n\n\`\`\`\n${e}\n\`\`\``);
      try { await client.addLabel(item.issueNumber, `error:${agent.name}`); } catch {}
      // Clean up the worktree since we're bailing
      try { execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: repoRoot, stdio: "pipe" }); } catch {}
      return;
    }
  }

  // Build prompt AFTER worktree creation so specs are read from the feature branch
  const prompt = await buildPromptForAgent(agent, item, agentCwd);

  // Re-index QMD in the worktree so the agent has the latest docs.
  // Gated on useWorktree because there's no isolated tree to re-index in
  // the no-worktree path; running QMD in repoRoot would mutate main's
  // index across other dispatcher cycles.
  if (useWorktree) {
    try {
      execSync(`qmd update 2>&1 && qmd embed 2>&1`, { cwd: agentCwd, encoding: "utf-8", timeout: 120_000 });
      console.log(`   📚 QMD index updated`);
    } catch (e) {
      console.warn(`   ⚠️  QMD re-index failed (agents will use stale index): ${e}`);
    }
  }

  // Agent CLAUDE.md files live in the agents repo, not the main repo
  const claudeMdPath = resolve(agentsRepoRoot, agent.claudeMdPath);
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(claudeMdPath, "utf-8");
  } catch (e) {
    console.error(`   ❌ Agent CLAUDE.md not found: ${claudeMdPath}`);
    if (item.issueNumber > 0) {
      await client.addComment(item.issueNumber, `## ⚠️ Dispatch Error: ${agent.name}\n\nAgent CLAUDE.md not found at \`${agent.claudeMdPath}\`. Check types.ts configuration.`);
    }
    if (useWorktree) {
      try { execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: repoRoot, stdio: "pipe" }); } catch {}
    }
    return;
  }

  const promptFile = resolve(__dirname, `../.prompt-${item.issueNumber}.txt`);
  const systemPromptFile = resolve(__dirname, `../.system-prompt-${agent.name}.txt`);
  writeFileSync(promptFile, prompt);
  writeFileSync(systemPromptFile, systemPrompt);

  // Turn limits: see `maxTurnsFor` in lib.ts for rationale (base 60,
  // code-review 100). Bumped from 50 → 60 on 2026-05-02 after #55.
  const maxTurns = maxTurnsFor(agent);
  const isCodeReview = agent.name === "code-review";

  // Tool access per agent role
  const baseTools = "Bash,Read,Write,Edit,Glob,Grep,TodoWrite,mcp__qmd__query,mcp__qmd__get,mcp__qmd__multi_get,mcp__qmd__status,mcp__context7__resolve-library-id,mcp__context7__query-docs";
  const needsAgent = ["architect", "code-review"].includes(agent.name);
  let allowedTools = baseTools;
  if (needsAgent) allowedTools += ",Agent";

  const logFile = agentLogPath(agent.name, item.issueNumber);
  // Timeout tiers: code-review 40min (sub-agents), developer/docs 25min, light agents 20min
  const isMediumAgent = ["developer", "documentation"].includes(agent.name);
  const timeoutMs = isCodeReview ? 2_400_000 : isMediumAgent ? 1_500_000 : 1_200_000;
  const timeoutLabel = isCodeReview ? "40min" : isMediumAgent ? "25min" : "20min";

  writeLog(logFile, "DISPATCH", `Agent: ${agent.name}\nTicket: #${item.issueNumber} — ${item.title}\nBranch: ${branchName}\nWorktree: ${useWorktree ? worktreeDir : "none (PO on main)"}\nMax turns: ${maxTurns}\nTimeout: ${timeoutLabel}\nAllowed tools: ${allowedTools}`);
  writeLog(logFile, "PROMPT", prompt);
  writeLog(logFile, "SYSTEM PROMPT", systemPrompt);

  console.log(`   Running Claude Code as ${agent.name} (max ${maxTurns} turns)...`);
  console.log(`   📝 Log: ${logFile}`);

  // Stream result is stored outside try so the catch handler can access session_id
  let streamResult: StreamResult | null = null;
  // True after `attemptSaferSalvage` completed successfully — the
  // ticket got `error:max_turns_salvaged` + a draft PR. Gates the
  // success-path labeling so we don't ALSO add `ready:<agent>`
  // (which would auto-advance partial work to code-review).
  let saferSalvaged = false;
  try {
    streamResult = await runClaudeStreaming({
      promptFile,
      systemPromptFile,
      model: "opus",
      effort: "high",
      maxTurns,
      allowedTools,
      cwd: agentCwd,
      timeoutMs,
      logFile,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: agent.name } as NodeJS.ProcessEnv,
    });

    // Claude CLI can complete but report an error (e.g., max_turns reached, API error).
    // Special case: if the agent hit max_turns but already created a PR, treat as success.
    // The agent likely finished the work and ran out of turns on cleanup (todo updates, etc.).
    if (streamResult.isError) {
      let salvaged = false;
      if (streamResult.terminalReason === "max_turns" && item.issueNumber > 0) {
        try {
          const prCheck = execSync(
            `gh pr list --head "${branchName}" --state open --json number --jq '.[0].number'`,
            { cwd: agentCwd, encoding: "utf-8", timeout: 15_000 }
          ).trim();
          if (prCheck && !isNaN(parseInt(prCheck, 10))) {
            console.log(`   ⚠️  Hit max_turns but PR #${prCheck} exists — treating as success`);
            writeLog(logFile, "SALVAGED", `Agent hit max_turns (${streamResult.numTurns}) but PR #${prCheck} was already created. Treating as success.`);
            salvaged = true;
          }
        } catch { /* gh CLI failed — fall through to error path */ }
      }

      // Safer salvage: max_turns + clean vet/build + uncommitted work
      // → auto-commit, push, open DRAFT PR, label `error:max_turns_salvaged`.
      // Distinct from the PR-already-exists path above (which treats
      // max_turns as success). This path preserves work the agent
      // produced but didn't get to PR-create — keeps it visible while
      // forcing human triage (no auto-advance via `ready:<agent>`).
      if (!salvaged
          && streamResult.terminalReason === "max_turns"
          && useWorktree
          && item.issueNumber > 0) {
        const ok = await attemptSaferSalvage({
          agentCwd, branchName, agent, item,
          streamResult, client, logFile,
        });
        if (ok) {
          saferSalvaged = true;
          salvaged = true;
        }
      }

      if (!salvaged) {
        throw new Error(
          `Agent error (${streamResult.terminalReason}): ${streamResult.output?.slice(0, 500) || "no output"}`
        );
      }
    }

    const output = streamResult.output;
    const u = streamResult.usage;
    const usageSummary = [
      `Turns: ${streamResult.numTurns}`,
      `Duration: ${Math.round(streamResult.durationMs / 1000)}s`,
      `Input tokens: ${(u as any).input_tokens ?? 0}`,
      `Output tokens: ${(u as any).output_tokens ?? 0}`,
      `Cache read: ${(u as any).cache_read_input_tokens ?? 0}`,
      `Cache creation: ${(u as any).cache_creation_input_tokens ?? 0}`,
      `Cost: $${streamResult.totalCostUsd.toFixed(4)}`,
      `Session: ${streamResult.sessionId}`,
    ].join(" | ");

    writeLog(logFile, "OUTPUT (success)", output);
    writeLog(logFile, "USAGE", usageSummary);
    console.log(`   📊 ${usageSummary}`);

    const endTs = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const elapsedMin = Math.round((Date.now() - startTime) / 60_000);
    console.log(`   [${endTs}] ✅ ${agent.name} completed (${elapsedMin}min)`);
    console.log(`   Output (last 1000 chars):\n${output.slice(-1000)}`);

    // Safety net: commit any uncommitted changes BEFORE worktree cleanup
    // destroys them. Surfaced on #27 (architect's spec was Written but not
    // committed; `git worktree remove --force` destroyed it silently). Each
    // agent's CLAUDE.md should already commit its work, but this catches the
    // case where an agent forgets — which has happened, and the failure mode
    // is silent loss of the run's output. Run unconditionally inside the
    // worktree so we don't have to know which agents write files.
    if (item.issueNumber > 0 && useWorktree) {
      try {
        const dirty = execSync(`git status --porcelain`, { cwd: agentCwd, stdio: "pipe" }).toString();
        if (shouldAutoCommit(dirty)) {
          execSync(`git add -A`, { cwd: agentCwd, stdio: "pipe" });
          execSync(
            `git commit -m "${agent.name}: auto-commit uncommitted changes for #${item.issueNumber}"`,
            { cwd: agentCwd, stdio: "pipe" },
          );
          console.log(`   💾 Auto-committed uncommitted changes (agent forgot to commit)`);
        }
      } catch (e) {
        console.warn(`   ⚠️  Failed safety-net commit: ${e}`);
      }
    }

    // Push the feature branch from the worktree. Only agents that use a
    // worktree produce commits worth pushing; gating on useWorktree avoids
    // the cosmetic "src refspec doesn't match any" failure for PO runs
    // (PO doesn't write code, has no worktree, has no branch to push).
    if (item.issueNumber > 0 && useWorktree) {
      try {
        execSync(`git push -u origin ${branchName}`, { cwd: agentCwd, stdio: "pipe" });
        console.log(`   📤 Pushed ${branchName} to origin`);
      } catch (e) {
        console.warn(`   ⚠️  Failed to push ${branchName}: ${e}`);
      }
    }

    // Post-success labeling
    // Convention: agents add needs-rework:{target} directly (target = who should fix it).
    // The dispatch detects any needs-rework:* label and treats it as a rework signal.
    // Skipped when saferSalvaged: that path already set `error:max_turns_salvaged`
    // and posted its own comment; adding `ready:<agent>` here would auto-advance
    // partial work, which is exactly what the salvage path is designed to prevent.
    if (item.issueNumber > 0 && !saferSalvaged) {
      let reworkTarget: string | null = null;
      try {
        const postLabels = await client.getIssueLabels(item.issueNumber);
        const reworkLabel = postLabels.find(l => l.startsWith("needs-rework:"));
        if (reworkLabel) {
          reworkTarget = reworkLabel.replace("needs-rework:", "");
        }
        // Handle legacy generic "needs-rework" label
        if (postLabels.includes("needs-rework")) {
          try { await client.removeLabel(item.issueNumber, "needs-rework"); } catch {}
          if (!reworkTarget) reworkTarget = agent.name;
        }
      } catch (e) {
        console.warn(`   ⚠️  Failed to check post-run labels: ${e}`);
      }

      if (!reworkTarget) {
        try {
          await client.addLabel(item.issueNumber, `ready:${agent.name}`);
          console.log(`   🏷️  Added ready:${agent.name} to #${item.issueNumber}`);
        } catch (e) {
          console.warn(`   ⚠️  Failed to add ready:${agent.name} label: ${e}`);
        }
      } else {
        console.log(`   🔄 Rework requested → needs-rework:${reworkTarget}`);
      }

      try {
        await client.addComment(
          item.issueNumber,
          reworkTarget
            ? `## 🤖 ${agent.description}\n\n${agent.name} agent flagged issues on this ticket → rework by **${reworkTarget}**.\n\n<details>\n<summary>Agent output (click to expand)</summary>\n\n\`\`\`\n${output.slice(-3000)}\n\`\`\`\n</details>\n\n**Needs rework by ${reworkTarget}.** See agent findings above.`
            : `## 🤖 ${agent.description}\n\n${agent.name} agent has completed work on this ticket.\n\n<details>\n<summary>Agent output (click to expand)</summary>\n\n\`\`\`\n${output.slice(-3000)}\n\`\`\`\n</details>\n\n**Ready for human review.** Move to the next column when approved.`
        );
      } catch (e) {
        console.warn(`   ⚠️  Failed to post completion comment: ${e}`);
      }
    }

    if (!saferSalvaged) {
      await notifyDiscord(`✅ **${agent.name}** finished #${item.issueNumber}: ${item.title}\n${item.url}\nReady for review.`);
    }

  } catch (error: any) {
    const sessionId = streamResult?.sessionId || "unknown";
    const sessionHint = sessionId !== "unknown"
      ? `\nSession: ${sessionId} (resume with: claude --resume ${sessionId})`
      : "";
    writeLog(logFile, "ERROR", `${error.message}${sessionHint}`);

    const endTs = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const elapsedMin = Math.round((Date.now() - startTime) / 60_000);
    console.error(`   [${endTs}] ❌ ${agent.name} failed (${elapsedMin}min): ${error.message}`);
    if (sessionId !== "unknown") {
      console.error(`   🔍 Resume session: claude --resume ${sessionId}`);
    }
    if (item.issueNumber > 0) {
      try {
        await client.addLabel(item.issueNumber, `error:${agent.name}`);
        console.log(`   🏷️  Added error:${agent.name} to #${item.issueNumber}`);
      } catch {}
      try {
        await client.addComment(
          item.issueNumber,
          `## ⚠️ Agent Error: ${agent.name}\n\nThe ${agent.name} agent encountered an error:\n\n\`\`\`\n${error.message.slice(-2000)}\n\`\`\`${sessionId !== "unknown" ? `\n\n**Debug**: \`claude --resume ${sessionId}\`` : ""}\n\nManual intervention required.`
        );
      } catch {}
    }
    await notifyDiscord(`❌ **${agent.name}** failed on #${item.issueNumber}: ${item.title}\n${item.url}\nManual intervention required.`);
  }

  // Clean up worktree (always, even on error)
  if (useWorktree) {
    try {
      execSync(`git worktree remove --force "${worktreeDir}"`, { cwd: repoRoot, stdio: "pipe" });
      console.log(`   🧹 Removed worktree`);
    } catch (e) {
      console.warn(`   ⚠️  Failed to remove worktree: ${e}`);
    }
    // Clean up any files leaked to the main repo by agent sub-processes
    // (e.g., Claude Code's own worktree recovery writes to .claude/worktrees/ in the main repo)
    try {
      execSync(`git checkout -- .`, { cwd: repoRoot, stdio: "pipe" });
      execSync(`git clean -fd --exclude=.env --exclude=agents/dispatch/logs --exclude=agents/dispatch/node_modules`, { cwd: repoRoot, stdio: "pipe" });
    } catch (e) {
      console.warn(`   ⚠️  Failed to clean main repo: ${e}`);
    }
  }

  // Ensure main repo is on main branch (PO may have left it elsewhere)
  if (!useWorktree) {
    try {
      execSync(`git checkout main`, { cwd: repoRoot, stdio: "pipe" });
    } catch {}
  }
}

// Closed-sweep: any closed issue that isn't already in Done gets moved
// there. Catches PO splitting + closing the parent (the parent stays in
// Backlog status until something moves it), tickets the user closes
// manually (won't-fix, duplicates), and anything else closed-but-stranded.
// Runs BEFORE auto-advance and rework routing so we never waste an advance
// or a route on a closed ticket.

async function runClosedSweep(client: GitHubProjectClient): Promise<void> {
  try {
    const closed = await client.getClosedItemsNotInDone();
    for (const item of closed) {
      try {
        await client.updateItemStatus(item.id, "Done");
        console.log(`   ✓ Closed-sweep: moved #${item.issueNumber} (${item.status} → Done)`);
      } catch (e) {
        console.warn(`   ⚠️  Failed to move closed #${item.issueNumber} to Done: ${e}`);
      }
    }
  } catch (error: any) {
    console.error(`Error running closed-sweep: ${error.message}`);
  }
}

// Auto-advance moves tickets forward when an agent passes; rework labels
// route backward (see runReworkRouting). The rule data + helpers live in
// lib.ts so they can be unit-tested without spinning up the dispatcher.

async function runAutoAdvance(client: GitHubProjectClient): Promise<void> {
  // Probe in-flight: any non-errored ticket in mid-pipeline columns.
  let inFlight = false;
  try {
    const midItems = await Promise.all(
      MID_PIPELINE_COLUMNS.map(c => client.getItemsByStatus(c)),
    );
    inFlight = isPipelineInFlight(midItems.flat());
  } catch (error: any) {
    // Fail-open: a transient GraphQL error shouldn't deadlock the pipeline.
    console.warn(`   ⚠️  In-flight probe failed; auto-advance proceeds without WIP gate: ${error.message}`);
  }

  // Fetch items for each unique `from` column referenced by the rule table.
  // Building once and passing into the pure decision keeps I/O bounded and
  // the decision deterministic.
  const fromColumns = [...new Set(AUTO_ADVANCE_RULES.map(r => r.from))];
  const itemsByColumn = new Map<string, ProjectItem[]>();
  try {
    const fetched = await Promise.all(fromColumns.map(c => client.getItemsByStatus(c)));
    fromColumns.forEach((c, i) => itemsByColumn.set(c, fetched[i]));
  } catch (error: any) {
    console.error(`Error fetching auto-advance candidate items: ${error.message}`);
    return;
  }

  // Pure decision — see decideAutoAdvance for semantics (gate skip, WIP=1
  // hold, within-cycle stop-after-first-Backlog-advance, mid-pipeline
  // advance-all). Test surface lives in lib.test.ts.
  const decision = decideAutoAdvance(AUTO_ADVANCE_RULES, MANUAL_ADVANCE_GATES, itemsByColumn, inFlight);

  // Apply advances.
  for (const adv of decision.advances) {
    try {
      await client.updateItemStatus(adv.itemId, adv.toColumn);
      console.log(`   📋 Auto-moved #${adv.issueNumber} from ${adv.fromColumn} → ${adv.toColumn}`);
    } catch (e) {
      console.warn(`   ⚠️  Failed to move #${adv.issueNumber} to ${adv.toColumn}: ${e}`);
    }
  }

  // Heartbeat logs for diagnostics. Visible in poll output so gates and
  // holds aren't silent.
  for (const gate of decision.gatedAwaiting) {
    const numbers = gate.itemNumbers.map(n => `#${n}`).join(", ");
    const target = AUTO_ADVANCE_RULES.find(r => r.from === gate.column)?.to ?? "?";
    console.log(`   🚦 ${gate.column}: ${numbers} awaiting human review (move to ${target} when ready)`);
  }
  if (decision.backlogHeld.length > 0) {
    const numbers = decision.backlogHeld.map(n => `#${n}`).join(", ");
    console.log(`   🛑 Backlog: ${numbers} held — another ticket is mid-pipeline (WIP=1)`);
  }
}

// Backward routing: when an agent adds needs-rework:{target}, move the ticket
// to the target agent's column and strip the label so the target can pick it
// up. AGENT_COLUMN_MAP and extractReworkTarget live in lib.ts.

async function runReworkRouting(client: GitHubProjectClient): Promise<void> {
  // Fetch items in every agent's column (one query per column, in parallel).
  const itemsByColumn = new Map<string, ProjectItem[]>();
  for (const agent of AGENTS) {
    try {
      const items = await client.getItemsByStatus(agent.column);
      itemsByColumn.set(agent.column, items);
    } catch (error: any) {
      console.error(`Error scanning ${agent.column} for rework routing: ${error.message}`);
    }
  }

  // Pure decision — see decideReworkRoutes for semantics (first valid
  // rework label wins, self-loops skipped, label stripping rules). Test
  // surface lives in lib.test.ts.
  const routes = decideReworkRoutes(AGENT_COLUMN_MAP, itemsByColumn);

  // Apply each route: check rework counter (halt at threshold), move
  // the item, strip stale labels, increment the counter.
  for (const route of routes) {
    // Find the source item to read its current rework count.
    const srcItems = itemsByColumn.get(route.fromColumn) ?? [];
    const srcItem = srcItems.find(it => it.id === route.itemId);
    const currentCount = srcItem ? extractReworkCount(srcItem.labels) : 0;

    // Circuit breaker: halt rework routing on tickets that have reached
    // the threshold. Adds error:rework-loop and a comment for human
    // attention. Catches the recursive-rework class of failure
    // (Pyrycode #41 hit 6 dev↔architect rounds before the dev agent
    // self-halted by intelligence — this makes the halt structural).
    if (currentCount >= REWORK_LOOP_THRESHOLD) {
      try {
        await client.addLabel(route.issueNumber, "error:rework-loop");
        await client.addComment(
          route.issueNumber,
          `## 🛑 Rework loop detected\n\nThis ticket has been rework'd ${currentCount} times across the pipeline. ` +
          `Halting dispatch to prevent further token burn.\n\n` +
          `**Triggering label this round:** \`${route.triggerLabel}\`\n` +
          `**Routed from:** ${route.fromColumn} (would have moved to ${route.toColumn})\n\n` +
          `Manual intervention required. Inspect prior agent comments to find the root cause; ` +
          `clear \`error:rework-loop\` and \`rework-count:${currentCount}\` to resume dispatch.`,
        );
        console.log(`   🛑 Rework loop: #${route.issueNumber} hit threshold ${REWORK_LOOP_THRESHOLD} — halting dispatch (was: ${route.fromColumn} → ${route.toColumn})`);
      } catch (e) {
        console.warn(`   ⚠️  Failed to set rework-loop error on #${route.issueNumber}: ${e}`);
      }
      continue;
    }

    try {
      await client.updateItemStatus(route.itemId, route.toColumn);
      for (const label of route.labelsToStrip) {
        try { await client.removeLabel(route.issueNumber, label); } catch {}
      }
      // Bump the rework counter. Strip the old label first if present.
      if (currentCount > 0) {
        try { await client.removeLabel(route.issueNumber, `rework-count:${currentCount}`); } catch {}
      }
      try { await client.addLabel(route.issueNumber, `rework-count:${currentCount + 1}`); } catch {}
      const transition = route.fromColumn === route.toColumn
        ? `cleared at ${route.toColumn}`
        : `moved ${route.fromColumn} → ${route.toColumn}`;
      console.log(`   ↩️  Rework: #${route.issueNumber} ${transition} (${route.triggerLabel}, count ${currentCount + 1}/${REWORK_LOOP_THRESHOLD})`);
    } catch (e) {
      console.warn(`   ⚠️  Failed to route rework for #${route.issueNumber}: ${e}`);
    }
  }
}

// Done-cleanup: strip pipeline-state labels from any ticket sitting in
// the Done column. Runs every maintenance pass alongside auto-advance.
//
// `runAutoAdvance` moves tickets into Done by status-only — it doesn't
// strip the `ready:<agent>` labels that drove each advance. The auto-merge
// block (later in pollLoop) cleans labels, but only when a PR exists and
// merges cleanly. Doc-only tickets, manually-merged PRs, and
// closed-as-won't-fix all reach Done with their pipeline labels intact.
// This pass closes the gap. See `decideDoneCleanup` in lib.ts.

async function runDoneCleanup(client: GitHubProjectClient): Promise<void> {
  let doneItems: ProjectItem[];
  try {
    doneItems = await client.getItemsByStatus("Done");
  } catch (error: any) {
    console.error(`Error fetching Done items for cleanup: ${error.message}`);
    return;
  }

  // Pure decision — see decideDoneCleanup for what gets stripped (pipeline
  // state labels + rework-count:) and what doesn't (size:, priority:,
  // merged, free-form tags). Test surface lives in lib.test.ts.
  const cleanups = decideDoneCleanup(doneItems);

  for (const cleanup of cleanups) {
    for (const label of cleanup.labelsToStrip) {
      try {
        await client.removeLabel(cleanup.issueNumber, label);
      } catch {
        // Soft-fail: label may have been removed by another path
        // (auto-merge cleanup, manual edit) between the fetch and this
        // op. Idempotency carries us through.
      }
    }
    console.log(`   🧹 Done-cleanup: stripped ${cleanup.labelsToStrip.length} pipeline label(s) from #${cleanup.issueNumber}`);
  }
}

async function pollLoop(): Promise<void> {
  const client = new GitHubProjectClient({
    owner: process.env.GITHUB_OWNER!,
    repo: process.env.GITHUB_REPO!,
    projectNumber: parseInt(process.env.PROJECT_NUMBER!, 10),
    token: process.env.GITHUB_TOKEN!,
    ownerType: "organization",
  });

  await client.initialize();

  // Poll later pipeline stages first — finish what's closest to Done before
  // starting new work. This minimizes WIP and maximizes throughput.
  // PO is included — it owns Backlog and handles rework/split requests.
  const pollOrder = [...AGENTS].reverse();

  console.log("🔄 Starting dispatch loop...");
  console.log(`   Watching columns (finish-first): ${pollOrder.map((a) => a.column).join(", ")}`);

  const POLL_INTERVAL = 30_000;

  while (true) {
    // Reconcile state FIRST every cycle: closed-sweep, route rework labels,
    // auto-advance ready:* tickets, then strip pipeline labels off any
    // ticket now sitting in Done. This makes restart behavior predictable —
    // any ticket left in `ready:<agent>` in the previous agent's column moves
    // forward on the same cycle as the next agent dispatch, not the cycle
    // after. Without this, a restart with a `ready:developer` ticket in In
    // Development takes two full cycles to advance + dispatch code-review;
    // if the dispatcher stops between the cycles, the ticket stays stuck.
    // Surfaced 2026-05-02 after dispatcher stop left #73 unable to advance
    // through code-review. The end-of-cycle maintenance (below) stays as a
    // safety net for state changes produced by this cycle's dispatch.
    await runClosedSweep(client);
    await runReworkRouting(client);
    await runAutoAdvance(client);
    await runDoneCleanup(client);

    // WIP=1: dispatch exactly one agent per cycle, then restart.
    // The finish-first poll order ensures the most-advanced ticket is always processed first.
    // This prevents round-robin (all tickets through architect, then all through developer)
    // and instead completes each ticket end-to-end before starting the next.
    let dispatched = false;

    for (const agent of pollOrder) {
      if (dispatched) break;

      try {
        const items = await client.getItemsByStatus(agent.column);

        for (const item of items) {
          // Label-based dispatch: skip if any of ready:/needs-rework:/wip:/error:
          // is already set for THIS agent. See shouldSkipDispatch in lib.ts.
          if (shouldSkipDispatch(item.labels, agent.name)) {
            continue;
          }

          // GitHub-native dependency check: skip if blockers are open
          // AND this agent's work depends on the blocker. PO bypasses
          // this — refinement (user story shape, AC, size) is cheap prep
          // work that doesn't depend on the blocker's implementation, so
          // queueing PO on blocked tickets means they're ready to flow
          // the moment the blocker resolves. See `shouldSkipBlockedFor`.
          if (item.issueNumber > 0 && shouldSkipBlockedFor(agent.name, item.blockedBy)) {
            const open = item.blockedBy.filter(b => b.state === "OPEN").map(b => `#${b.number}`).join(", ");
            console.log(`   🔒 #${item.issueNumber} blocked by ${open} — skipping ${agent.name} dispatch`);
            continue;
          }

          const wipLabel = `wip:${agent.name}`;

          // Remove stale pipeline labels from previous agents before dispatching.
          for (const label of item.labels) {
            if (isPipelineLabel(label)) {
              try {
                await client.removeLabel(item.issueNumber, label);
                console.log(`   🏷️  Removed stale ${label} from #${item.issueNumber}`);
              } catch {}
            }
          }
          // Also remove legacy labels if present
          for (const legacy of ["ready-for-review", "needs-rework"]) {
            if (item.labels.includes(legacy)) {
              try {
                await client.removeLabel(item.issueNumber, legacy);
                console.log(`   🏷️  Removed legacy ${legacy} from #${item.issueNumber}`);
              } catch {}
            }
          }

          // Mark ticket as in-progress before running agent
          try {
            await client.addLabel(item.issueNumber, wipLabel);
            console.log(`   🏷️  Added ${wipLabel} to #${item.issueNumber}`);
          } catch {}

          await dispatchToAgent(agent, item, client);

          // Remove wip label after agent completes (ready/needs-rework label added inside dispatchToAgent)
          try {
            await client.removeLabel(item.issueNumber, wipLabel);
          } catch {}

          // Sweep closed-but-not-Done first (parent of a split, user-closed
          // tickets), then route rework labels (backward), then auto-advance
          // (forward), then strip pipeline labels off Done tickets. Order
          // matters: closed → done before route/advance so we never waste
          // an op on a closed ticket; Done-cleanup last so it sees tickets
          // brought into Done by closed-sweep AND auto-advance this cycle.
          await runClosedSweep(client);
          await runReworkRouting(client);
          await runAutoAdvance(client);
          await runDoneCleanup(client);

          // Break both loops — restart from the most-advanced column
          dispatched = true;
          break;
        }
      } catch (error: any) {
        console.error(`Error polling ${agent.column}: ${error.message}`);
      }
    }

    // Maintenance: closed-sweep, route rework labels, auto-advance, and
    // strip pipeline labels off Done tickets. Runs even when nothing was
    // dispatched (catches tickets advanced/closed by humans or label
    // changes between cycles).
    await runClosedSweep(client);
    await runReworkRouting(client);
    await runAutoAdvance(client);
    await runDoneCleanup(client);

    // Auto-merge PRs for tickets in the Done column
    try {
      const doneItems = await client.getItemsByStatus("Done");
      for (const item of doneItems) {
        // Skip epics and items without issue numbers
        if (item.issueNumber <= 0) continue;
        // Skip if already merged (no open PR)
        if (item.labels.includes("merged")) continue;

        try {
          // Find open PR for this issue's feature branch
          const prCheck = execSync(
            `gh pr list --head "feature/${item.issueNumber}" --state open --json number --jq '.[0].number'`,
            { cwd: repoRoot, encoding: "utf-8", timeout: 15_000 }
          ).trim();

          if (!prCheck) continue;

          const prNumber = parseInt(prCheck, 10);
          if (isNaN(prNumber)) continue;

          console.log(`   🔀 Auto-merging PR #${prNumber} for #${item.issueNumber} (moved to Done)`);
          execSync(
            `gh pr merge ${prNumber} --merge --delete-branch`,
            { cwd: repoRoot, encoding: "utf-8", timeout: 30_000 }
          );
          // Pull merged changes to local main
          try {
            execSync(`git checkout main && git pull`, { cwd: repoRoot, stdio: "pipe", timeout: 15_000 });
          } catch {}

          // Clean up pipeline labels — they're noise on completed tickets.
          for (const label of item.labels) {
            if (isPipelineLabel(label)) {
              try { await client.removeLabel(item.issueNumber, label); } catch {}
            }
          }

          console.log(`   ✅ PR #${prNumber} merged, branch feature/${item.issueNumber} deleted, labels cleaned`);
          await notifyDiscord(`🔀 PR #${prNumber} merged for #${item.issueNumber}: ${item.title}`);
        } catch (e: any) {
          if (e.message?.includes("merge conflict") || e.stderr?.includes("merge conflict")) {
            console.warn(`   ⚠️  PR for #${item.issueNumber} has merge conflicts — skipping auto-merge`);
          }
          // Otherwise silently skip (no PR, already merged, etc.)
        }
      }
    } catch (error: any) {
      console.error(`Error polling Done column: ${error.message}`);
    }

    if (dispatched) {
      // Something was dispatched — restart cycle immediately to process the next stage
      // for the same ticket (WIP=1: finish one ticket before starting another)
      continue;
    }

    console.log(`⏰ Sleeping ${POLL_INTERVAL / 1000}s...`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

// dispatchInbox: drop a rough ticket directly into the Inbox column.
//
// Replaces the old dispatchPO. The pre-2026-05-01 design ran the PO agent
// on a synthetic ProjectItem (issueNumber=0) to create issues from CLI
// requests — which conflated PO's two roles (creator + refiner) and
// short-circuited the dispatcher's auto-label-on-success at line 584
// (it can't label a fake issue). The new design splits the roles: this
// function only creates the issue and lands it in Inbox; PO operates on
// real Backlog tickets via the normal dispatchToAgent path after a human
// promotes Inbox → Backlog.
//
// Three GraphQL/REST calls, in order:
//   1. createIssue(title, body) — REST POST /repos/.../issues
//   2. addItemToProject(nodeId) — GraphQL addProjectV2ItemById
//   3. updateItemStatus(itemId, "Inbox") — GraphQL updateProjectV2ItemFieldValue
//
// All three must succeed; partial state would orphan the issue (created
// but not on board, or on board but null-status). If a step fails, error
// out clearly so the user can clean up manually.
async function dispatchInbox(request: string): Promise<void> {
  const client = new GitHubProjectClient({
    owner: process.env.GITHUB_OWNER!,
    repo: process.env.GITHUB_REPO!,
    projectNumber: parseInt(process.env.PROJECT_NUMBER!, 10),
    token: process.env.GITHUB_TOKEN!,
    ownerType: "organization",
  });

  await client.initialize();

  // First line of the request becomes the title, full request becomes the
  // body. PO can rewrite both during refinement; this is just to give the
  // issue an addressable shape.
  const trimmed = request.trim();
  const firstLine = trimmed.split(/\r?\n/)[0] ?? trimmed;
  const title = firstLine.length > 100
    ? firstLine.slice(0, 97).trimEnd() + "..."
    : firstLine;
  const body = trimmed;

  console.log(`📥 Creating Inbox ticket: "${title}"`);
  const issue = await client.createIssue(title, body);
  console.log(`   Issue #${issue.number}: ${issue.url}`);

  console.log(`   Adding to project board...`);
  const itemId = await client.addItemToProject(issue.nodeId);

  console.log(`   Setting status to Inbox...`);
  await client.updateItemStatus(itemId, "Inbox");

  console.log(`✅ #${issue.number} landed in Inbox.\n`);
  console.log(`When you're ready for PO to refine it, move it to Backlog:`);
  console.log(`   web UI → drag from Inbox to Backlog`);
  console.log(`   or: gh project item-edit --id ${itemId} --project-id <id> --field-id <Status field id> --single-select-option-id <Backlog option id>`);
}

// Entry point
const args = process.argv.slice(2);

if (args[0] === "inbox" && args[1]) {
  dispatchInbox(args.slice(1).join(" ")).catch((e) => {
    console.error("Fatal error in inbox dispatch:", e);
    process.exit(1);
  });
} else if (args[0] === "po" && args[1]) {
  // Backwards-compat shim: old `pnpm start po "..."` now delegates to
  // dispatchInbox with a deprecation notice. PO no longer runs on raw
  // requests — it only refines triaged Backlog tickets.
  console.warn("⚠️  `pnpm start po` is deprecated. Use `pnpm start inbox` instead.");
  console.warn("    PO no longer creates tickets from raw requests; tickets land in Inbox");
  console.warn("    and are promoted to Backlog manually when ready for PO to refine.\n");
  dispatchInbox(args.slice(1).join(" ")).catch((e) => {
    console.error("Fatal error in inbox dispatch:", e);
    process.exit(1);
  });
} else {
  pollLoop().catch((e) => {
    console.error("Fatal error in poll loop:", e);
    process.exit(1);
  });
}
