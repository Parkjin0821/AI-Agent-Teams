import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = createApp({
  root,
  dataDir: path.join(root, 'data'),
  projectsDir: path.join(root, 'projects'),
  enableExec: process.env.AGENT_HQ_ENABLE_EXEC === '1',
  tickMs: 30_000,
  detectEnvironments: true,
});

const port = Number(process.env.PORT || 4310);
app.server.listen(port, '127.0.0.1', () => console.log(`AGENT HQ http://localhost:${port}`));
