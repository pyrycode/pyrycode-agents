export interface ProjectConfig {
  owner: string;
  repo: string;
  projectNumber: number;
  token: string;
  ownerType: "user" | "organization";
}

/** Minimal blocker info — issue number + open/closed state. */
export interface BlockerInfo {
  number: number;
  state: "OPEN" | "CLOSED";
}

export interface ProjectItem {
  id: string;           // Project item ID (for GraphQL mutations)
  issueId: string;      // Issue node ID
  issueNumber: number;
  title: string;
  body: string;
  status: string;
  labels: string[];
  url: string;
  /** Issues that block this one (GitHub native `addBlockedBy` relationship).
   *  Empty when the ticket has no dependencies. The dispatcher skips
   *  dispatch on tickets where any entry is `OPEN`. */
  blockedBy: BlockerInfo[];
}

export interface AgentConfig {
  name: string;
  column: string;
  claudeMdPath: string;
  description: string;
  /**
   * True if this agent runs in a git worktree branched from main and
   * produces commits the dispatcher should push to a feature branch.
   * False for agents that only modify external state (issues, PRs,
   * project board) — currently only PO.
   *
   * Adding a new agent forces an explicit decision here; missing the
   * field is a typecheck error, not a silent default. Predicate is
   * `shouldUseWorktree()` in lib.ts (also keys the post-run push and
   * the safety-net commit).
   */
  usesWorktree: boolean;
}

// 5-agent pipeline: PO → Architect → Developer → Code Review → Documentation
// Skipped: UX Designer (no UI), Security (local-only daemon), QA (Go tests handled by Developer + CI)
export const AGENTS: AgentConfig[] = [
  {
    name: "po",
    column: "Backlog",
    claudeMdPath: "po/CLAUDE.md",
    description: "Product Owner — creates structured issues",
    usesWorktree: false, // operates on issue body via gh, no commits
  },
  {
    name: "architect",
    column: "In Architecture",
    claudeMdPath: "architect/CLAUDE.md",
    description: "System Architect — defines Go interfaces, data flows, concurrency patterns",
    usesWorktree: true, // writes spec to docs/specs/architecture/
  },
  {
    name: "developer",
    column: "In Development",
    claudeMdPath: "developer/CLAUDE.md",
    description: "Developer — implements Go code with tests",
    usesWorktree: true, // writes Go code + tests
  },
  {
    name: "code-review",
    column: "In Code Review",
    claudeMdPath: "code-review/CLAUDE.md",
    description: "Code Reviewer — reviews PRs for Go quality and correctness",
    usesWorktree: true, // reads code locally to review
  },
  {
    name: "documentation",
    column: "In Documentation",
    claudeMdPath: "documentation/CLAUDE.md",
    description: "Documentation Agent — synthesizes project knowledge base",
    usesWorktree: true, // writes to docs/
  },
];
