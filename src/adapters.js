import { spawn } from "node:child_process";

function commandFor(provider, prompt, cwd) {
  if (provider === "claude") {
    return {
      file: "claude",
      args: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", prompt],
      cwd,
    };
  }
  return {
    file: "codex",
    args: ["exec", "--json", "--sandbox", "workspace-write", "--cd", cwd, prompt],
    cwd,
  };
}

export class CliAgentAdapter {
  constructor({ enabled = false, cwd = process.cwd() } = {}) {
    this.enabled = enabled;
    this.cwd = cwd;
  }

  async run(provider, prompt, onEvent, { cwd } = {}) {
    if (!this.enabled) {
      onEvent({ type: "provider.notice", provider, message: "Safe mode: CLI execution is disabled" });
      return { outcome: "simulated", summary: `${provider} dry-run only; no work executed` };
    }

    if (!cwd) throw new Error('Project workspace is required for CLI execution');
    const command = commandFor(provider, prompt, cwd);
    return new Promise((resolve) => {
      const child = spawn(command.file, command.args, {
        cwd: command.cwd,
        shell: false,
        windowsHide: true,
        env: process.env,
      });
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => onEvent({ type: "provider.output", provider, chunk }));
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => resolve({ outcome: "failed", summary: error.message }));
      child.on("close", (code) => {
        if (code === 0) return resolve({ outcome: "completed", summary: `${provider} completed` });
        const limited = /limit|quota|usage|capacity/i.test(stderr);
        resolve({ outcome: limited ? "limited" : "failed", summary: stderr.trim() || `${provider} exited ${code}` });
      });
    });
  }
}
