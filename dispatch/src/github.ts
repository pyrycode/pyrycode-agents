import { graphql } from "@octokit/graphql";
import type { ProjectConfig, ProjectItem } from "./types.js";

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3,
  delayMs = 1000,
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      return response;
    } catch (error) {
      if (attempt === retries) throw error;
      console.warn(`   ⚠️  fetch attempt ${attempt}/${retries} failed, retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }
  throw new Error("fetchWithRetry: unreachable");
}

export class GitHubProjectClient {
  private gql: typeof graphql;
  private config: ProjectConfig;
  private projectId: string | null = null;
  private statusFieldId: string | null = null;
  private statusOptions: Map<string, string> = new Map();

  constructor(config: ProjectConfig) {
    this.config = config;
    this.gql = graphql.defaults({
      headers: { authorization: `token ${config.token}` },
    });
  }

  async initialize(): Promise<void> {
    // Support both user and organization project owners
    const ownerField = this.config.ownerType === "organization" ? "organization" : "user";

    const result: any = await this.gql(`
      query($owner: String!, $number: Int!) {
        ${ownerField}(login: $owner) {
          projectV2(number: $number) {
            id
            fields(first: 30) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
              }
            }
          }
        }
      }
    `, {
      owner: this.config.owner,
      number: this.config.projectNumber,
    });

    const project = result[ownerField].projectV2;
    this.projectId = project.id;

    const statusField = project.fields.nodes.find(
      (f: any) => f.name === "Status"
    );
    if (!statusField) throw new Error("Status field not found on project");

    this.statusFieldId = statusField.id;
    for (const opt of statusField.options) {
      this.statusOptions.set(opt.name, opt.id);
    }

    console.log(`Initialized: project=${this.projectId}`);
    console.log(`Status options: ${[...this.statusOptions.keys()].join(", ")}`);
  }

  async getItemsByStatus(status: string): Promise<ProjectItem[]> {
    if (!this.projectId) throw new Error("Not initialized");

    const result: any = await this.gql(`
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: 100) {
              nodes {
                id
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                  }
                }
                content {
                  ... on Issue {
                    id
                    number
                    title
                    body
                    url
                    state
                    labels(first: 10) {
                      nodes { name }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `, { projectId: this.projectId });

    const items: ProjectItem[] = [];
    for (const node of result.node.items.nodes) {
      const itemStatus = node.fieldValueByName?.name;
      if (itemStatus !== status) continue;
      if (!node.content) continue;
      if (node.content.state === "CLOSED") continue;

      items.push({
        id: node.id,
        issueId: node.content.id,
        issueNumber: node.content.number,
        title: node.content.title,
        body: node.content.body ?? "",
        status: itemStatus,
        labels: node.content.labels.nodes.map((l: any) => l.name),
        url: node.content.url,
      });
    }

    return items;
  }

  async updateItemStatus(itemId: string, newStatus: string): Promise<void> {
    if (!this.projectId || !this.statusFieldId) {
      throw new Error("Not initialized");
    }

    const optionId = this.statusOptions.get(newStatus);
    if (!optionId) {
      throw new Error(
        `Unknown status "${newStatus}". Available: ${[...this.statusOptions.keys()].join(", ")}`
      );
    }

    await this.gql(`
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item { id }
        }
      }
    `, {
      projectId: this.projectId,
      itemId,
      fieldId: this.statusFieldId,
      optionId,
    });
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to add comment: ${response.statusText}`);
    }
  }

  async getIssueLabels(issueNumber: number): Promise<string[]> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/labels`,
      {
        headers: {
          Authorization: `token ${this.config.token}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get labels: ${response.statusText}`);
    }

    const labels: any[] = await response.json();
    return labels.map((l) => l.name);
  }

  /**
   * Create a new issue in the configured repo via the REST API.
   * Returns both the issue number (for human-facing links) and the
   * GraphQL node ID (needed for addItemToProject).
   */
  async createIssue(
    title: string,
    body: string,
    labels: string[] = [],
  ): Promise<{ number: number; nodeId: string; url: string }> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${this.config.token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify({ title, body, labels }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to create issue: ${response.status} ${response.statusText}`);
    }

    const issue: any = await response.json();
    return {
      number: issue.number,
      nodeId: issue.node_id,
      url: issue.html_url,
    };
  }

  /**
   * Add an existing issue (by GraphQL node ID) to the project. Returns the
   * project item ID so the caller can immediately set its status.
   *
   * The combination `createIssue` + `addItemToProject` + `updateItemStatus`
   * is the dispatchInbox flow: an issue lands in the project at the right
   * status with a single sequence of mutations and no null-status race.
   */
  async addItemToProject(issueNodeId: string): Promise<string> {
    if (!this.projectId) throw new Error("Not initialized");

    const result: any = await this.gql(`
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {
          projectId: $projectId
          contentId: $contentId
        }) {
          item { id }
        }
      }
    `, {
      projectId: this.projectId,
      contentId: issueNodeId,
    });

    return result.addProjectV2ItemById.item.id;
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/labels`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ labels: [label] }),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to add label: ${response.statusText}`);
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `token ${this.config.token}`,
        },
      }
    );

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to remove label: ${response.statusText}`);
    }
  }
}
