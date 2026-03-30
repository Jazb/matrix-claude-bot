/**
 * Converts a PermissionConfig into CLI arguments for the Claude binary.
 *
 * Maps permission modes to their corresponding flags:
 *   - "default"           → (no extra flags)
 *   - "acceptEdits"       → --permission-mode acceptEdits
 *   - "plan"              → --permission-mode plan
 *   - "auto"              → --permission-mode auto --enable-auto-mode
 *   - "bypassPermissions" → --dangerously-skip-permissions
 *   - allowedTools        → --allowedTools "tool1" "tool2" ...
 */

import type { PermissionConfig, ProjectsConfig } from "../config/schema.js";

/**
 * Build CLI args for the given permission config.
 */
export function buildPermissionArgs(perm: PermissionConfig): string[] {
  const args: string[] = [];

  switch (perm.mode) {
    case "default":
      break;
    case "acceptEdits":
    case "plan":
      args.push("--permission-mode", perm.mode);
      break;
    case "auto":
      args.push("--permission-mode", "auto", "--enable-auto-mode");
      break;
    case "bypassPermissions":
      args.push("--dangerously-skip-permissions");
      break;
  }

  if (perm.allowedTools.length > 0) {
    for (const tool of perm.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }

  return args;
}

/**
 * Resolve the effective permission config for a project.
 * Project-level overrides take precedence over the global default.
 */
export function resolvePermission(
  projectsConfig: ProjectsConfig,
  projectName: string,
  sessionOverride?: PermissionConfig | null,
): PermissionConfig {
  // Session-level override (from !permission command) takes highest priority
  if (sessionOverride) return sessionOverride;

  const entry = projectsConfig.projects[projectName];
  // Project-level override
  if (entry?.permission) return entry.permission;

  // Global default
  return projectsConfig.defaultPermission;
}

/**
 * Human-readable label for a permission config.
 */
export function permissionLabel(perm: PermissionConfig): string {
  if (perm.allowedTools.length > 0) {
    return `${perm.mode} + allowedTools: ${perm.allowedTools.join(", ")}`;
  }
  return perm.mode;
}
