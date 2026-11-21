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
  /** 旧字段：承诺隔几天再提。保留兼容，新逻辑改用 remindRepeatMin。 */
  promiseRepeatDays: number;
  /** 承诺提醒的可打扰时段（含开始，不含结束），跨夜也支持。 */
  remindWindowStart: string;
  remindWindowEnd: string;
  /** 两条承诺提醒之间至少隔多久（分钟）。 */
  remindMinGapMin: number;
  /** 每天最多提醒几条（0 = 不限）。 */
  remindDailyCap: number;
  /** 同一条承诺没回应时，隔多久再提（分钟）。 */
  remindRepeatMin: number;
  /** 同一条承诺最多提醒几次，到顶就只留在体检页。 */
  remindMaxTimes: number;
  /** 对方最近没说话时是否也允许提醒；默认 false（等 TA 出现再说）。 */
  remindWithoutUser: boolean;
  /** 打开上一条时，超过多少小时未处理才允许在无人时提醒。 */
  remindForceAfterHours: number;
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
  /** 放开白名单：所有外部消息都记（含群聊、以及自己发的）。默认关。 */
  captureAll: boolean;
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
  /** 排序时是否参考「上次被想起的时间」：久不用的旧卡不抢新卡的位。 */
  recallUseAging: boolean;
  /** 每轮主动想起几条（0 = 关）。预激活，不占工具调用。 */
  preactivateLines: number;
  /** 多久没被想起就沉到冷层（天）。0 = 关闭自动分层。 */
  chillAfterDays: number;
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
  requireRecentUserHours: 5,
  promiseRepeatDays: 1,
  remindWindowStart: '08:00',
  remindWindowEnd: '23:00',
  remindMinGapMin: 120,
  remindDailyCap: 3,
  remindRepeatMin: 180,
  remindMaxTimes: 6,
  remindWithoutUser: false,
  remindForceAfterHours: 6,
  quietStart: '23:30',
  quietEnd: '08:00',
  sleepStart: '01:00',
  sleepEnd: '08:00',
  memoryEnabled: true,
  captureTurns: true,
  // 真实 senderKey 长这样：private:1940008084（QQ 私聊）、desktop-pet.chat（桌宠对话）。
  // 老默认值一个都匹配不上，导致原文库一直是 0 行 —— 改这个 regex 前先看一遍 data/runs/*/events.jsonl。
  captureSenders: '^(desktop-pet\\.(chat|message|answer|voice)|private:|qq\\.private\\.|qq-official\\.c2c[.:]|starpost\\.private\\.)',
  captureAll: false,
  captureMinLength: 4,
  rawRetentionDays: 14,
  rawArchiveDays: 365,
  captureBackfill: false,
  recallLimit: 5,
  recallMaxChars: 600,
  recallUseAging: true,
  preactivateLines: 2,
  /** 对方开口时，把「自我意识」插件独处时写下的那一句带进上下文。 */
  shareSelfThought: true,
  /** 把她独处时特别在意的那些（重要度 8 以上）写成 self 卡片，进星图。 */
  absorbSelfThought: true,
  chillAfterDays: 30,
  contextEveryMin: 0,
  nightlyConsolidate: true,
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
const RAW_GROUP: ConfigGroup = {
  id: 'world:memory-core',
  owner: 'world:memory-core',
  schema: {
    type: 'object',
    title: '记忆核心',
    description: '卡片 + 4 个工具 + 一段提示词。装好后角色会自己往里写，也在你开口时自动带出几条旧的。第一次启动会把旧插件的记忆只读导入一次，原文件不动。',
    properties: {
      'worlds.memory-core.proactiveEnabled': {
        type: 'boolean',
        title: '主动开口',
        description: '按自己的节奏找对方说一句。关掉后只在对方开口时回应。',
        'x-hot': true,
      },
      'worlds.memory-core.proactiveMinGapMin': num('两次主动的最小间隔', '默认 100 分钟。太短会显得粘人，也费 token。', 15, 720, '分钟'),
      'worlds.memory-core.proactiveJitterMin': num('随机抖动', '在最小间隔上加 0 到这么多分钟的随机量，避免每天准点开口。', 0, 120, '分钟'),
      'worlds.memory-core.proactiveDailyCap': num('每天主动上限', '一次主动约 1-2 万 token（看上下文长度），3 次大概 5 万。0 = 不限。', 0, 12, '次'),
      'worlds.memory-core.idleGateMin': num('对方刚说话后的静默', '窗口内不主动，免得打断。', 0, 240, '分钟'),
      'worlds.memory-core.requireRecentUserHours': num('对方多久没说话就不主动', '超过这个时长就当没人在，主动会对着空房间说话、白花钱。0 = 不限制。', 0, 72, '小时'),
      'worlds.memory-core.promiseRepeatDays': num('承诺隔几天再提一次（旧）', '旧字段，保留兼容；现在由下面「同一条没回应时隔多久再提」控制。', 0, 30, '天'),
      'worlds.memory-core.remindWindowStart': {
        type: 'string',
        title: '承诺提醒时段 · 开始',
        description: '24 小时制 HH:MM。默认 08:00–23:00；起止相同等于不限制。夜里到期不会吵醒人，等进入时段再提。',
        default: '08:00',
      } as never,
      'worlds.memory-core.remindWindowEnd': {
        type: 'string',
        title: '承诺提醒时段 · 结束',
        description: '默认 23:00。',
        default: '23:00',
      } as never,
      'worlds.memory-core.remindMinGapMin': num('两条承诺提醒至少隔多久', '防止几条同时到期时连着轰炸。默认 120 分钟。', 15, 1440, '分钟'),
      'worlds.memory-core.remindDailyCap': num('每天最多提醒几条承诺', '默认 3 条；超出的留到明天或体检页手动提。0 = 不限。', 0, 20, '条'),
      'worlds.memory-core.remindRepeatMin': num('同一条没回应时隔多久再提', '默认 180 分钟。对方没回、也没标完成，才会再提。', 30, 1440, '分钟'),
      'worlds.memory-core.remindMaxTimes': num('同一条最多提醒几次', '到顶就只留在体检页，不再主动提。默认 6 次（约三天）。', 1, 30, '次'),
      'worlds.memory-core.remindWithoutUser': {
        type: 'boolean',
        title: '对方不在时也提醒',
        description: '默认关：只登记，等对方出现再说（策略 A）。打开后，超过下面那个小时数仍未处理的，会在时段内主动推一次（策略 B）。',
        default: false,
      },
      'worlds.memory-core.remindForceAfterHours': num('无人时最多等多久', '仅在上面开关打开时生效。默认 6 小时。', 1, 72, '小时'),
      'worlds.memory-core.quietStart': {
        type: 'string',
        title: '免打扰开始',
        description: '24 小时制 HH:MM。起止相同等于不启用。',
        'x-hot': true,
      },
      'worlds.memory-core.quietEnd': {
        type: 'string',
        title: '免打扰结束',
        description: '24 小时制 HH:MM。起止相同等于不启用。',
        'x-hot': true,
      },
      'worlds.memory-core.sleepStart': {
        type: 'string',
        title: '睡觉开始',
        description: '这个时段里状态显示「在睡觉」，精力按「睡觉」逻辑回升；和免打扰不是一回事——免打扰只是不主动开口。',
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
      'worlds.memory-core.shareSelfThought': {
        type: 'boolean',
        title: '带上她独处时写下的话',
        description: '对方开口时，把她一个人待着时写在本子上的一句带进上下文——会标明时间，也会说明「不一定是你现在的想法」。关掉就只是本地记录，永远不进对话。',
        default: true,
      },
      'worlds.memory-core.absorbSelfThought': {
        type: 'boolean',
        title: '独处时的想法进记忆',
        description: '她独处时写下的、她自己标成「很重要」的那些（8 分以上），会收成一条「关于她自己」的记忆，出现在星图上。卡片里会写清「独处时写下」，不会被当成此刻的想法。',
        default: true,
      },
      'worlds.memory-core.captureTurns': {
        type: 'boolean',
        title: '存对话原文',
        description: '把最近的对话存成一行行本地文本，供「搜最近聊过什么」。默认只存白名单里的人；打开下面那项后，群里其他人和你自己说的也会存。',
        'x-hot': true,
      },
      'worlds.memory-core.captureAll': {
        type: 'boolean',
        title: '所有人说的话都记',
        description: '关着只记白名单里的人（默认），打开后群里其他人、以及你自己发的也会落盘。落盘只影响原文库，不增加每轮成本。',
        default: false,
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
        description: '打开后重启一次：把宿主还留着的历史消息补扫进原文库。只补没扫过的；补完就不会再跑，开关留着不用管。',
        'x-hot': false,
      },
      'worlds.memory-core.recallLimit': num('一次召回给几条', '默认 5 条。给多了挤占上下文。', 1, 12, '条'),
      'worlds.memory-core.recallMaxChars': num('召回结果字数上限', '超过就截断，默认 600 字。', 120, 2000, '字'),
      'worlds.memory-core.recallUseAging': {
        type: 'boolean',
        title: '久不用的记忆让位',
        description: '排序时参考「上次被想起的时间」：长期没被召回、权重又低的卡排到后面。关掉就退回只看关键词、标签和权重。',
      },
      'worlds.memory-core.preactivateLines': num('每轮主动想起几条', '按对方刚说的话自动带出几条旧记忆，不用模型自己去查。0 = 关。每条约 20 字，默认 2 条。', 0, 3, '条'),
      'worlds.memory-core.chillAfterDays': num('多久没想起就沉到冷层', '超过这个天数没被用过的低权重「经历/临时」记忆会沉到冷层：不再主动想起、不占「最近」，但搜索仍能找到，可一键回暖。事实、自我和未完成的承诺不会被沉。**沉下去不是删除**：搜索仍找得到，只是在星图上退到冷层；要真删去卡片详情里删。0 = 关闭。', 0, 3650, '天'),
      'worlds.memory-core.contextEveryMin': num('状态投递间隔', '每隔这么多分钟把「我在做什么」推到上下文里。0 = 不推（默认，最省）；推一次约 60 token，但每轮都在历史里。', 0, 240, '分钟'),
      'worlds.memory-core.nightlyConsolidate': {
        type: 'boolean',
        title: '夜间整理',
        description: '夜里把当天的原文收成一份材料，等你下次开口时交给它整理（最多 3 条，能写成 fact 就不写 episode）。不额外发请求。默认开。',
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


/**
 * 设置页的显示顺序：把「总开关 / 看记忆 / 每轮想起几条」放最前，
 * 主动开口和作息往后——那些是角色行为，不是记忆本身。
 * 用显式顺序表而不是直接调换定义位置，改起来不容易漏项。
 */
const SETTINGS_ORDER = [
  'worlds.memory-core.memoryEnabled',
  'worlds.memory-core.siteEnabled',
  'worlds.memory-core.sitePort',
  'worlds.memory-core.preactivateLines',
  'worlds.memory-core.shareSelfThought',
  'worlds.memory-core.absorbSelfThought',
  'worlds.memory-core.captureTurns',
  'worlds.memory-core.captureAll',
  'worlds.memory-core.captureSenders',
  'worlds.memory-core.captureMinLength',
  'worlds.memory-core.recallLimit',
  'worlds.memory-core.recallMaxChars',
  'worlds.memory-core.recallUseAging',
  'worlds.memory-core.chillAfterDays',
  'worlds.memory-core.rawRetentionDays',
  'worlds.memory-core.rawArchiveDays',
  'worlds.memory-core.captureBackfill',
  'worlds.memory-core.nightlyConsolidate',
  'worlds.memory-core.nightlyHour',
  'worlds.memory-core.workspaceScanEnabled',
  'worlds.memory-core.workspaceDirs',
  'worlds.memory-core.workspaceExts',
  'worlds.memory-core.workspaceMaxFiles',
  'worlds.memory-core.workspaceMaxFileKB',
  'worlds.memory-core.proactiveEnabled',
  'worlds.memory-core.proactiveMinGapMin',
  'worlds.memory-core.proactiveJitterMin',
  'worlds.memory-core.proactiveDailyCap',
  'worlds.memory-core.idleGateMin',
  'worlds.memory-core.requireRecentUserHours',
  'worlds.memory-core.promiseRepeatDays',
  'worlds.memory-core.remindWindowStart',
  'worlds.memory-core.remindWindowEnd',
  'worlds.memory-core.remindMinGapMin',
  'worlds.memory-core.remindDailyCap',
  'worlds.memory-core.remindRepeatMin',
  'worlds.memory-core.remindMaxTimes',
  'worlds.memory-core.remindWithoutUser',
  'worlds.memory-core.remindForceAfterHours',
  'worlds.memory-core.quietStart',
  'worlds.memory-core.quietEnd',
  'worlds.memory-core.sleepStart',
  'worlds.memory-core.sleepEnd',
  'worlds.memory-core.energyDecayPerHour',
  'worlds.memory-core.contextEveryMin',
];

export const MEMORY_CORE_CONFIG_GROUP: ConfigGroup = (() => {
  const props = (RAW_GROUP.schema.properties ?? {}) as Record<string, unknown>;
  const known = SETTINGS_ORDER.filter((k) => k in props);
  // 顺序表里没写到的项也不能丢：追加到末尾，宁可顺序难看也别少一个开关
  const rest = Object.keys(props).filter((k) => !known.includes(k));
  const ordered = [...known, ...rest].map((k) => [k, props[k]] as const);
  return {
    ...RAW_GROUP,
    schema: { ...RAW_GROUP.schema, properties: Object.fromEntries(ordered) },
  };
})();
