import { randomUUID } from "node:crypto";
import { validateProjectId } from './workspaces.js';

export const TaskStatus = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  AWAITING_APPROVAL: "awaiting_approval",
  HANDOFF: "handoff",
  COMPLETED: "completed",
  FAILED: "failed",
});

export function chooseProvider(task, availability) {
  const preferred = task.critical || task.complexity === "high" ? "codex" : "claude";
  if (availability[preferred] === "available") return preferred;
  const fallback = preferred === "claude" ? "codex" : "claude";
  return availability[fallback] === "available" ? fallback : null;
}

export function validateCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length > 20 || criteria.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)) {
    throw new Error('completionCriteria must contain up to 20 non-empty strings');
  }
  return criteria.map(item => item.trim());
}

export function createTask(input) {
  if (!input?.title?.trim() || !input?.prompt?.trim()) {
    throw new Error("title and prompt are required");
  }
  return {
    id: randomUUID(),
    projectId: validateProjectId(input.projectId ?? 'default'),
    completionCriteria: validateCriteria(input.completionCriteria ?? []),
    team: input.team || 'development',
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    complexity: input.complexity === "high" ? "high" : "normal",
    critical: Boolean(input.critical),
    requiresApproval: Boolean(input.requiresApproval),
    status: TaskStatus.QUEUED,
    provider: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    checkpoint: {
      objective: input.prompt.trim(),
      completed: [],
      changedFiles: [],
      verification: [],
      nextAction: "Start task",
      providerSessionId: null,
    },
  };
}

export function buildHandoff(task, reason, target) {
  return [
    `Continue task: ${task.title}`,
    `Objective: ${task.checkpoint.objective}`,
    `Completion criteria: ${(task.completionCriteria || []).join('; ') || 'not specified'}`,
    `Previous provider: ${task.provider ?? "none"}`,
    `Handoff reason: ${reason}`,
    `Completed: ${task.checkpoint.completed.join("; ") || "none"}`,
    `Changed files: ${task.checkpoint.changedFiles.join(", ") || "none"}`,
    `Verification: ${task.checkpoint.verification.join("; ") || "none"}`,
    `Next action: ${task.checkpoint.nextAction}`,
    `Target provider: ${target}`,
    "Inspect the current workspace before changing files. Preserve existing work and verify completion.",
  ].join("\n");
}
