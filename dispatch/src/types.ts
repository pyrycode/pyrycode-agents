export interface ProjectConfig {
  owner: string;
  repo: string;
  projectNumber: number;
  token: string;
  ownerType: "user" | "organization";
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
}

export interface AgentConfig {
  name: string;
  column: string;
  claudeMdPath: string;
  description: string;
}

// 5-agent pipeline: PO → Architect → Developer → Code Review → Documentation
// Skipped: UX Designer (no UI), Security (local-only daemon), QA (Go tests handled by Developer + CI)
export const AGENTS: AgentConfig[] = [
  {
    name: "po",
    column: "Backlog",
    claudeMdPath: "agents/po/CLAUDE.md",
    description: "Product Owner — creates structured issues",
  },
  {
    name: "architect",
    column: "In Architecture",
    claudeMdPath: "agents/architect/CLAUDE.md",
    description: "System Architect — defines Go interfaces, data flows, concurrency patterns",
  },
  {
    name: "developer",
    column: "In Development",
    claudeMdPath: "agents/developer/CLAUDE.md",
    description: "Developer — implements Go code with tests",
  },
  {
    name: "code-review",
    column: "In Code Review",
    claudeMdPath: "agents/code-review/CLAUDE.md",
    description: "Code Reviewer — reviews PRs for Go quality and correctness",
  },
  {
    name: "documentation",
    column: "In Documentation",
    claudeMdPath: "agents/documentation/CLAUDE.md",
    description: "Documentation Agent — synthesizes project knowledge base",
  },
];
