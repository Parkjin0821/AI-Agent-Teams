import { existsSync, mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  constructor(root, { titleFor = () => '', canRename = () => true } = {}) {
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new Error('Workspace root cannot be a link');
    this.root = realpathSync(root);
    this.titleFor = titleFor;
    this.canRename = canRename;
    this.mapFile = path.join(this.root, '.프로젝트경로.json');
    const boundary = path.join(this.root, 'package.json');
    if (!existsSync(boundary)) writeFileSync(boundary, `${JSON.stringify(BOUNDARY, null, 2)}\n`, { flag: 'wx' });
  }
  readMap() {
    if (!existsSync(this.mapFile)) return Object.create(null);
    if (lstatSync(this.mapFile).isSymbolicLink()) throw new Error('Workspace map cannot be a link');
    const map = JSON.parse(readFileSync(this.mapFile, 'utf8'));
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Invalid workspace map');
    for (const [id, folder] of Object.entries(map)) {
      validateProjectId(id);
      if (typeof folder !== 'string' || !folder || /[\\/:*?"<>|\x00-\x1f]/.test(folder)
        || folder.startsWith('.') || /[. ]$/.test(folder) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(folder))
        throw new Error('Invalid workspace folder');
    }
    return Object.assign(Object.create(null), map);
  }
  saveMap(map) {
    const temp = path.join(this.root, `.프로젝트경로-${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(map, null, 2) + '\n', { flag: 'wx' });
    renameSync(temp, this.mapFile);
  }
  folderFor(projectId) {
    const id = validateProjectId(projectId), map = this.readMap();
    if (Object.hasOwn(map, id)) return map[id];
    const title = this.titleFor(id);
    if (!title || (existsSync(path.join(this.root, id)) && !this.canRename(id))) return id;
    let base = Array.from(String(title).normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '')).slice(0, 80).join('').trim().replace(/[. ]+$/, '') || '프로젝트';
    if (!/[가-힣]/.test(base)) base = `프로젝트-${base}`;
    let folder = base;
    for (let n = 2; Object.values(map).some(v => v.toLowerCase() === folder.toLowerCase()) || existsSync(path.join(this.root, folder)); n++)
      folder = `${base} (${n})`;
    map[id] = folder;
    // Save before moving so a subsequent resolve can finish an interrupted migration.
    this.saveMap(map);
    return folder;
  }
  resolve(projectId) {
    const id = validateProjectId(projectId), legacy = path.join(this.root, id);
    if (existsSync(legacy) && lstatSync(legacy).isSymbolicLink()) throw new Error('Project workspace cannot be a link');
    const target = path.join(this.root, this.folderFor(id));
    if (target !== legacy && existsSync(legacy)) {
      if (!this.canRename(id)) return realpathSync(legacy);
      if (existsSync(target)) throw new Error('Both legacy and named workspaces exist; refusing to merge');
      if (path.dirname(realpathSync(legacy)) !== this.root || path.dirname(target) !== this.root) throw new Error('Workspace escapes project root');
      renameSync(legacy, target);
    }
    mkdirSync(target, { recursive: true });
    if (lstatSync(target).isSymbolicLink()) throw new Error('Project workspace cannot be a link');
    const resolved = realpathSync(target);
    if (path.dirname(resolved) !== this.root) throw new Error('Workspace escapes project root');
    return resolved;
  }
  // Deletes one project folder. A link is refused, so nothing outside the project root can be removed.
  remove(projectId) {
    const id = validateProjectId(projectId), map = this.readMap();
    const target = path.join(this.root, Object.hasOwn(map, id) ? map[id] : id);
    if (!existsSync(target)) return false;
    if (lstatSync(target).isSymbolicLink()) throw new Error('Project workspace is a link; refusing to delete');
    if (path.dirname(realpathSync(target)) !== this.root) throw new Error('Workspace escapes project root');
    rmSync(target, { recursive: true, force: true });
    return true;
  }
}
