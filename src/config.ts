/**
 * worlds['memory-core'] 的形状、默认值与设置页表单。
 * 默认 enabled=false：没在部署配置里打开时不会运行。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface MemoryCoreConfig {
  enabled: boolean;
  /** 主动开口总开关。 */
  proactiveEnabled: boolean;
  /** 两次主动之间的最小间隔（分钟）。 */
  proactiveMinGapMin: number;
  /** 在最小间隔上再加的随机抖动上限（分钟），避免准点开口。 */
  proactiveJitterMin: number;
  /** 每天主动上限（0 = 不限，不建议）。 */
  proactiveDailyCap: number;
  /** 对方刚说过话后的静默窗口（分钟）。 */
  idleGateMin: number;
  /** 只有最近这么多小时内对方说过话才主动（0 = 不限制）。 */
  requireRecentUserHours: number;
  /** 免打扰开始（含）。 */
  quietStart: string;
  /** 免打扰结束（不含）。 */
  quietEnd: string;
  /** 睡觉开始（含）。 */
  sleepStart: string;
  /** 睡觉结束（不含）。 */
  sleepEnd: string;
  /** 记忆总开关。 */
  memoryEnabled: boolean;
  /** 是否把最近 7 天的对话原文存到本地，供检索。 */
  captureTurns: boolean;
  /** 哪些来源算「对方在跟我说话」，正则匹配 senderKey。 */
  captureSenders: string;
  /** 短于这么多字的对话原文不存（过滤表情、单字、口令回执）。 */
  captureMinLength: number;
  /** 对话原文保留天数（热数据，超过就按天归档）。 */
  rawRetentionDays: number;
  /** 归档保留天数（0 = 永久）。 */
  rawArchiveDays: number;
  /** 启动后把历史事件重扫一遍补录（只做一次）。 */
  captureBackfill: boolean;
  /** 一次召回最多给几条。 */
  recallLimit: number;
  /** 召回结果的总字数上限。 */
  recallMaxChars: number;
  /** 每隔多少分钟把状态作为一条事件投递一次（0 = 不投递，最省）。 */
  contextEveryMin: number;
  /** 夜间是否唤醒一轮让角色整理记忆（会多一次完整请求）。 */
  nightlyConsolidate: boolean;
  /** 夜间整理的小时（0-23）。 */
  nightlyHour: number;
  /** 醒着时每小时掉的精力。 */
  energyDecayPerHour: number;
  /** 检索时是否连工作区里的笔记文件一起搜。 */
  workspaceScanEnabled: boolean;
  /** 要搜的目录，逗号分隔；支持 {workspace} {bot} {data}。 */
  workspaceDirs: string;
  /** 只搜这些后缀。 */
  workspaceExts: string;
  /** 最多读多少个文件。 */
  workspaceMaxFiles: number;
  /** 单个文件超过这么多 KB 就跳过。 */
  workspaceMaxFileKB: number;
  /** 记忆地图站点开关。 */
  siteEnabled: boolean;
  /** 记忆地图站点端口，被占会自动往后试。 */
  sitePort: number;
}

export const MEMORY_CORE_DEFAULTS: MemoryCoreConfig = {
  enabled: false,
  proactiveEnabled: true,
  proactiveMinGapMin: 100,
  proactiveJitterMin: 25,
  proactiveDailyCap: 3,
  idleGateMin: 20,
  requireRecentUserHours: 8,
  quietStart: '23:30',
  quietEnd: '08:00',
  sleepStart: '01:00',
  sleepEnd: '08:00',
  memoryEnabled: true,
  captureTurns: true,
  // 真实 senderKey 长这样：private:1940008084（QQ 私聊）、desktop-pet.chat（桌宠对话）。
  // 老默认值一个都匹配不上，导致原文库一直是 0 行 —— 改这个 regex 前先看一遍 data/runs/*/events.jsonl。
  captureSenders: '^(desktop-pet\\.(chat|message|answer|voice)|private:|qq\\.private\\.|starpost\\.private\\.)',
  captureMinLength: 4,
  rawRetentionDays: 7,
  rawArchiveDays: 90,
  captureBackfill: false,
  recallLimit: 5,
  recallMaxChars: 600,
  contextEveryMin: 0,
  nightlyConsolidate: false,
  nightlyHour: 3,
  energyDecayPerHour: 2.2,
  workspaceScanEnabled: true,
  workspaceDirs: '{workspace}/memories,{workspace}/notes',
  workspaceExts: 'md,txt',
  workspaceMaxFiles: 300,
  workspaceMaxFileKB: 256,
  siteEnabled: true,
  sitePort: 7801,
};

const num = (
  title: string,
  description: string,
  minimum: number,
  maximum: number,
  suffix: string,
): Record<string, unknown> => ({
  type: 'integer',
  title,
  description,
  minimum,
  maximum,
  'x-suffix': suffix,
  'x-hot': true,
});

/** 设置页表单：键是 cfg 里的点分路径。全部热更新，改完不用重启。 */
export const MEMORY_CORE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:memory-core',
  owner: 'world:memory-core',
  schema: {
    type: 'object',
    title: '记忆核心',
    description: '四套记忆合成的一套：一张卡片表 + 4 个工具 + 一段提示词。前面那四套插件的记忆会在第一次启动时只读导入，原文件不动。',
    properties: {
      'worlds.memory-core.proactiveEnabled': {
        type: 'boolean',
        title: '主动开口',
        description: '按自己的节奏找对方说一句。关掉后只在对方开口时回应。',
        'x-hot': true,
      },
      'worlds.memory-core.proactiveMinGapMin': num('两次主动的最小间隔', '默认 100 分钟。太短会显得粘人，也费 token。', 15, 720, '分钟'),
      'worlds.memory-core.proactiveJitterMin': num('随机抖动', '在最小间隔上加 0 到这么多分钟的随机量，避免每天准点开口。', 0, 120, '分钟'),
      'worlds.memory-core.proactiveDailyCap': num('每天主动上限', '每次主动都是一次完整请求，3 次约等于 30 万 token。0 = 不限。', 0, 12, '次'),
      'worlds.memory-core.idleGateMin': num('对方刚说话后的静默', '窗口内不主动，免得打断。', 0, 240, '分钟'),
      'worlds.memory-core.requireRecentUserHours': num('对方多久没说话就不主动', '超过这个时长就当没人在，主动会对着空房间说话、白花钱。0 = 不限制。', 0, 72, '小时'),
      'worlds.memory-core.quietStart': {
        type: 'string',
        title: '免打扰开始',
        description: '24 小时制 HH:MM。起止相同等于不启用。',
        'x-hot': true,
      },
      'worlds.memory-core.quietEnd': {
        type: 'string',
        title: '免打扰结束',
        description: '24 小时制 HH:MM。',
        'x-hot': true,
      },
      'worlds.memory-core.sleepStart': {
        type: 'string',
        title: '睡觉开始',
        description: '这个时段里状态会显示「在睡觉」，精力回升。',
        'x-hot': true,
      },
      'worlds.memory-core.sleepEnd': {
        type: 'string',
        title: '睡觉结束',
        'x-hot': true,
      },
      'worlds.memory-core.memoryEnabled': {
        type: 'boolean',
        title: '记忆',
        description: '关掉后不再读写卡片，已有记录仍留在数据目录。',
        'x-hot': true,
      },
      'worlds.memory-core.captureTurns': {
        type: 'boolean',
        title: '存对话原文',
        description: '把对方最近的私聊存成一行行本地文本，供「搜最近聊过什么」。只存这一个方向，不存你自己说的话。',
        'x-hot': true,
      },
      'worlds.memory-core.captureSenders': {
        type: 'string',
        title: '算作对话的来源',
        description: '正则匹配事件的 senderKey。默认认 QQ 私聊（private:数字）、桌宠对话（desktop-pet.chat / voice）、星邮私聊；群聊不算。填错了一个字都录不到，改完看「对话原文」页有没有进新行。',
        'x-hot': true,
      },
      'worlds.memory-core.captureMinLength': num('原文最短几个字', '短于这个长度的消息不进原文库（表情、单字、口令回执照样过滤）。', 1, 20, '字'),
      'worlds.memory-core.rawRetentionDays': num('原文热数据天数', '超过这么多天的对话会挪进 archive/ 按天归档，不再直接删。', 1, 90, '天'),
      'worlds.memory-core.rawArchiveDays': num('归档保留天数', '归档按天存，超过这么多天的文件在启动时删掉。0 = 永久保留（占盘，自己看着办）。', 0, 3650, '天'),
      'worlds.memory-core.captureBackfill': {
        type: 'boolean',
        title: '重扫历史补录',
        description: '打开后重启一次：把水位倒回开头，把宿主还留着的历史消息重扫一遍。只做一次，做完自动关掉自己。',
        'x-hot': false,
      },
      'worlds.memory-core.recallLimit': num('一次召回给几条', '默认 5 条。给多了挤占上下文。', 1, 12, '条'),
      'worlds.memory-core.recallMaxChars': num('召回结果字数上限', '超过就截断，默认 600 字。', 120, 2000, '字'),
      'worlds.memory-core.contextEveryMin': num('状态投递间隔', '每隔这么多分钟把「我在做什么」推到上下文里。0 = 不推（默认，最省）；推一次约 60 token，但每轮都在历史里。', 0, 240, '分钟'),
      'worlds.memory-core.nightlyConsolidate': {
        type: 'boolean',
        title: '夜间整理',
        description: '每晚唤醒一轮，让它把当天的事写成几条 episode。会多一次完整请求（约 8-10 万 token），默认关。',
        'x-hot': true,
      },
      'worlds.memory-core.nightlyHour': num('夜间整理时间', '24 小时制的小时数。', 0, 23, '点'),
      'worlds.memory-core.energyDecayPerHour': {
        type: 'number',
        title: '精力每小时下降',
        description: '醒着时掉的精力，睡一觉回满。',
        minimum: 0,
        maximum: 20,
        'x-hot': true,
      },
      'worlds.memory-core.workspaceScanEnabled': {
        type: 'boolean',
        title: '连工作区笔记一起搜',
        description: '「你还记得吗」时，除了卡片和对话原文，也去笔记目录里找。只读，不改文件；结果带 60 秒缓存。',
        'x-hot': true,
      },
      'worlds.memory-core.workspaceDirs': {
        type: 'string',
        title: '要搜的目录',
        description: '逗号分隔。可用 {workspace}（部署的 workspace 目录）、{bot}（部署目录）、{data}（同 {bot}）。相对路径按 workspace 解析。',
        'x-hot': true,
      },
      'worlds.memory-core.workspaceExts': {
        type: 'string',
        title: '文件后缀',
        description: '逗号分隔，默认 md,txt。',
        'x-hot': true,
      },
      'worlds.memory-core.workspaceMaxFiles': num('最多读几个文件', '按修改时间取最近的。目录很大时调小，别让它拖慢召回。', 1, 2000, '个'),
      'worlds.memory-core.workspaceMaxFileKB': num('单文件上限', '超过就跳过，避免读到几 MB 的日志。', 16, 4096, 'KB'),
      'worlds.memory-core.siteEnabled': {
        type: 'boolean',
        title: '记忆地图站点',
        description: '在本机 127.0.0.1 起一个小站点，看图谱、时间线、原文，也能直接改卡片。改完要重载 World 才生效。',
        'x-hot': false,
      },
      'worlds.memory-core.sitePort': {
        type: 'integer',
        title: '记忆地图端口',
        description: '默认 7801。被占用会自动往后找 10 个。改完要重载 World 才生效。',
        minimum: 1024,
        maximum: 65535,
        'x-hot': false,
      },
    },
  },
};
