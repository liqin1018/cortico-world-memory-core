/** World 定义：id/label/defaults/create + 自描述（给扩展页看，不进提示词）。 */
import type { EventDescribe, ToolDescribe } from 'cortico/core/types.ts';
import type { WorldDefinition } from 'cortico/world.ts';
import { MEMORY_CORE_DEFAULTS, type MemoryCoreConfig } from './config.ts';
import { TOOL_SPECS } from './tools.ts';
import { MemoryCoreWorld } from './world.ts';

const SUMMARIES: Record<string, string> = {
  mcore_write: '写一条记忆卡片（事实/自己/经历/承诺/临时）。',
  mcore_recall: '按内容或时间检索记忆，也能查最近 7 天的对话原文与未完成的承诺。',
  mcore_state: '读写你自己的精力、心情、正在做什么、在哪。',
  mcore_plan: '安排今天的日程，作为主动开口的由头。',
};

const TOOLS: ToolDescribe[] = TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  parameters: spec.parameters,
  tags: spec.tags,
  summary: SUMMARIES[spec.name],
}));

const EVENTS: EventDescribe[] = [
  {
    type: 'mcore.wake',
    description: { zh: '主动开口的由头：从状态、未完成的承诺和日程里推出来的一小段理由，立即唤醒一轮。', en: 'A reason to speak first, derived from state, open promises and today\'s plan.' },
    trigger: 'flush',
  },
  {
    type: 'mcore.due',
    description: { zh: '答应过的事到点了，立即唤醒一轮提醒角色提一句。', en: 'A promise came due; wakes a turn so the character can bring it up.' },
    trigger: 'flush',
  },
  {
    type: 'mcore.context',
    description: { zh: '当前状态一行字，随下一批投递；默认关闭，避免每轮多带 token。', en: 'One line of current state, piggybacked. Off by default.' },
    trigger: 'piggyback',
    tags: ['snapshot'],
  },
  {
    type: 'mcore.nightly',
    description: { zh: '夜间整理：唤醒一轮，让它把今天写成几条 episode（默认关闭）。', en: 'Nightly consolidation turn (off by default).' },
    trigger: 'flush',
  },
];

export const MEMORY_CORE_WORLD: WorldDefinition<MemoryCoreConfig> = {
  id: 'memory-core',
  label: '记忆核心',
  defaults: () => ({ ...MEMORY_CORE_DEFAULTS }),
  create: (ctx) => new MemoryCoreWorld(ctx),
  describe: { tools: TOOLS, events: EVENTS },
};
