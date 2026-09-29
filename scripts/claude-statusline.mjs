import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1000000) throw new Error('Status input too large');
}
const data = JSON.parse(input);
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
if (data.rate_limits) {
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `claude-usage-${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify({ rate_limits: data.rate_limits, observedAt: new Date().toISOString() }));
  await rename(temp, path.join(dir, 'claude-usage.json'));
}
console.log('AGENT HQ · 공식 사용량 수집');
