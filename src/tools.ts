/**
 * 四个工具的声明（只给模型看的 schema）。handler 在 world.ts 里按名字分发。
 *
 * 这里的每一个字都要每一轮付一次钱，所以只留「模型必须知道才用得对」的东西：
 * 参数含义、枚举值、边界。写法和分寸放在 ENV_PROMPT 里，两边不重复。
 */
import type { ToolSpec } from 'cortico/core/types.ts';

const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'mcore_write',
    description:
      '写一条记忆。kind：fact=关于对方的事实，self=关于你自己的，episode=会改变你判断的一件事（别记流水账），'
      + 'promise=答应过的事（必须写 dueAt），note=临时信息。一条只写一件事，40-80 字。旧记录用 closes 关掉。',
    parameters: obj(
      {
        kind: {
          type: 'string',
          enum: ['fact', 'self', 'episode', 'promise', 'note'],
          description: '记忆类型',
        },
        text: { type: 'string', description: '内容，40-80 字' },
        weight: { type: 'number', description: '0-1，0.3 琐事 / 0.8 重要' },
        tags: { type: 'array', items: { type: 'string' }, description: '最多 6 个' },
        dueAt: { type: 'string', description: 'promise 用：ISO 或 YYYY-MM-DD HH:MM；没有截止时间写 none' },
        closes: { type: 'string', description: '要关掉的旧 id' },
      },
      ['kind', 'text'],
    ),
    tags: ['write'],
  },
  {
    name: 'mcore_recall',
    description:
      '查记忆。给 query 按内容搜（同时搜最近 7 天原文和工作区笔记），不给就看最近几条；'
      + 'mode=open 看没做完的承诺和今天的安排，mode=archive 翻归档（要 query）；'
      + '给 id 看这条记忆的出处（当时的原话 + 前后文）。'
      + '对方提到人或旧事、问「你还记得吗」时先查再答。',
    parameters: obj(
      {
        query: { type: 'string', description: '关键词就够' },
        id: { type: 'string', description: '看某条记忆的出处（传行首 8 位），会给出当时的原话和前后文' },
        kind: { type: 'string', enum: ['fact', 'self', 'episode', 'promise', 'note'], description: '只看某一类' },
        mode: { type: 'string', enum: ['search', 'recent', 'open', 'archive', 'voice'], description: '默认 search；voice = 给几句对方原话听语气' },
        days: { type: 'integer', description: '只看最近这么多天' },
        limit: { type: 'integer', description: '最多几条，默认 5' },
      },
      [],
    ),
    tags: ['read'],
  },
  {
    name: 'mcore_state',
    description: '你自己的状态：精力、心情、在做什么、在哪、睡没睡。这是你自己的，不要念成清单给对方听。',
    parameters: obj(
      {
        action: { type: 'string', enum: ['get', 'update', 'rest'], description: 'get 读 / update 改 / rest 睡' },
        energy: { type: 'number', description: '精力 0-100' },
        mood: { type: 'number', description: '心情 0-100' },
        activity: { type: 'string', description: '正在做什么' },
        location: { type: 'string', description: '在哪' },
        sleeping: { type: 'boolean', description: '在睡' },
      },
      ['action'],
    ),
    tags: ['read', 'write', 'snapshot'],
  },
  {
    name: 'mcore_plan',
    description: '你今天的安排。日程是你开口的由头，不用讲给对方听。',
    parameters: obj(
      {
        action: { type: 'string', enum: ['list', 'add', 'done', 'clear'], description: 'list 看 / add 加 / done 完成 / clear 清空' },
        time: { type: 'string', description: 'add 用，HH:MM' },
        title: { type: 'string', description: 'add 用，做什么' },
        place: { type: 'string', description: 'add 用，在哪（可省）' },
        id: { type: 'string', description: 'done 用，日程 id' },
      },
      ['action'],
    ),
    tags: ['read', 'write'],
  },
];
