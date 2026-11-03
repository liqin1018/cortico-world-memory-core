/**
 * 四个工具的声明（只给模型看的 schema）。handler 在 world.ts 里按名字分发。
 * 压缩 token 的地方在这里：四个工具覆盖写、查、状态、日程，description 一律短句。
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
      '写一条记忆。kind：fact=关于对方的事实，self=关于你自己的，episode=发生过的一件事（带感受），'
      + 'promise=答应过的事（写 dueAt），note=过几天就没用的临时信息。'
      + '一条只写一件事，40-80 字，写具体。同一件事不要重复写；把旧记录传进 closes 表示它已完成或作废。',
    parameters: obj(
      {
        kind: {
          type: 'string',
          enum: ['fact', 'self', 'episode', 'promise', 'note'],
          description: '记忆类型',
        },
        text: { type: 'string', description: '这条记忆的内容，40-80 字' },
        weight: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '在心里有多重：0.3 琐事 / 0.5 一般 / 0.8 重要。默认 0.5',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '关键词，最多 6 个' },
        dueAt: {
          type: 'string',
          description: '仅 promise 用：什么时候该做，ISO 时间或 YYYY-MM-DD HH:MM',
        },
        closes: { type: 'string', description: '要关掉的旧记录 id（已完成/已失效）' },
      },
      ['kind', 'text'],
    ),
    tags: ['write'],
  },
  {
    name: 'mcore_recall',
    description:
      '查记忆。不传 query 就是最近几条；传 query 按内容搜，最近 7 天的对话原文和工作区的笔记文件也会一起搜；'
      + 'mode=open 看还没做完的承诺与今天的安排；mode=archive 翻归档里的旧对话（要带 query）。'
      + '对方提到人、事、日期、旧约定，或问「你还记得吗」时先查再答。',
    parameters: obj(
      {
        query: { type: 'string', description: '要查的内容，几个关键词就够' },
        kind: { type: 'string', enum: ['fact', 'self', 'episode', 'promise', 'note'], description: '只看某一类' },
        mode: {
          type: 'string',
          enum: ['search', 'recent', 'open', 'archive'],
          description: '默认 search；没给 query 按 recent 处理',
        },
        days: { type: 'integer', minimum: 1, maximum: 3650, description: '只看最近这么多天' },
        limit: { type: 'integer', minimum: 1, maximum: 12, description: '最多几条，默认 5' },
      },
      [],
    ),
    tags: ['read'],
  },
  {
    name: 'mcore_state',
    description:
      '你自己的状态：精力、心情、正在做什么、在哪、睡没睡。action=get 读取；update 只改传入的字段；'
      + 'rest 去睡一会儿。这是你自己的，不要念成清单给对方听。',
    parameters: obj(
      {
        action: { type: 'string', enum: ['get', 'update', 'rest'], description: 'get 读，update 改，rest 睡' },
        energy: { type: 'number', minimum: 0, maximum: 100, description: '精力 0-100' },
        mood: { type: 'number', minimum: 0, maximum: 100, description: '心情 0-100' },
        activity: { type: 'string', description: '正在做什么，例如「翻旧照片」' },
        location: { type: 'string', description: '在哪，例如「窗台」' },
        sleeping: { type: 'boolean', description: '是否在睡' },
      },
      ['action'],
    ),
    tags: ['read', 'write', 'snapshot'],
  },
  {
    name: 'mcore_plan',
    description:
      '你今天的安排。action=list 看；add 加一条（time 用 HH:MM，title 写做什么，place 可省）；'
      + 'done 标完成（传 id）；clear 清空。日程是你开口的由头，不用讲给对方听。',
    parameters: obj(
      {
        action: { type: 'string', enum: ['list', 'add', 'done', 'clear'] },
        items: {
          type: 'array',
          description: 'add 用第一项',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              time: { type: 'string', description: 'HH:MM' },
              title: { type: 'string', description: '做什么' },
              place: { type: 'string', description: '在哪，可省略' },
            },
            required: ['time', 'title'],
          },
        },
        id: { type: 'string', description: 'done 用的日程 id' },
      },
      ['action'],
    ),
    tags: ['read', 'write'],
  },
];
