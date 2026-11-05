/**
 * 由 World 定义生成 describe.json —— 扩展市场的详情页读这个文件，不进提示词。
 * 发布前跑：node --experimental-transform-types --no-warnings tools/build-describe.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_CORE_WORLD } from '../src/definition.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const describe = MEMORY_CORE_WORLD.describe ?? {};
// 统一成 LF：Windows 检出是 CRLF，带进 describe.json 会白花 14 个字符的 token
const envPrompt = readFileSync(join(root, 'ENV_PROMPT.md'), 'utf8').replace(/\r\n/g, '\n').trim();

const out = {
  tools: describe.tools ?? [],
  events: describe.events ?? [],
  prompts: [
    {
      key: 'worlds.memory-core.envPrompt',
      title: '记忆核心 · 环境提示词',
      role: 'envPrompt',
      content: envPrompt,
    },
  ],
};

writeFileSync(join(root, 'describe.json'), `${JSON.stringify(out, null, 2)}\n`);

const chars = (o: unknown) => JSON.stringify(o).length;
console.log(`describe.json 已写入：${out.tools.length} 工具 / ${out.events.length} 事件 / 提示词 ${envPrompt.length} 字`);
console.log(`体积 ${chars(out)} 字符`);
for (const t of out.tools) console.log(`  ${t.name}  ${chars(t)} 字符 ≈${Math.round(chars(t) / 3.3)} tok`);
