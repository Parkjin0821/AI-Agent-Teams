import { existsSync, mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function validateProjectId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) {
    throw new Error('projectId must be a safe identifier (letters, digits, underscore or hyphen)');
  }
  return id.toLowerCase();
}

// Node resolves a project's module type from the nearest package.json. Without this boundary, projects
// under the AGENT HQ repo would inherit its "type": "module" and plain CommonJS code would fail.
const BOUNDARY = { private: true, type: 'commonjs', description: 'AGENT HQ projects root: keeps projects from inheriting the AGENT HQ package settings' };

export class ProjectWorkspaces {
  constructor(root) {
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new Error('Workspace root cannot be a link');
    this.root = realpathSync(root);
    const boundary = path.join(this.root, 'package.json');
    if (!existsSync(boundary)) writeFileSync(boundary, `${JSON.stringify(BOUNDARY, null, 2)}\n`, { flag: 'wx' });
  }
  resolve(projectId) {
    const target = path.join(this.root, validateProjectId(projectId));
    mkdirSync(target, { recursive: true });
    if (lstatSync(target).isSymbolicLink()) throw new Error('Project workspace cannot be a link');
    const resolved = realpathSync(target);
    if (path.dirname(resolved) !== this.root) throw new Error('Workspace escapes project root');
    return resolved;
  }
  // Deletes one project folder. A link is refused, so nothing outside the project root can be removed.
  remove(projectId) {
    const target = path.join(this.root, validateProjectId(projectId));
    if (!existsSync(target)) return false;
    if (lstatSync(target).isSymbolicLink()) throw new Error('Project workspace is a link; refusing to delete');
    if (path.dirname(realpathSync(target)) !== this.root) throw new Error('Workspace escapes project root');
    rmSync(target, { recursive: true, force: true });
    return true;
  }
}
