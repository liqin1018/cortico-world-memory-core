// 框架按 package.json 的 `main` 导入本文件，读取具名导出 id/label/defaults/create。
import { MEMORY_CORE_WORLD } from './definition.ts';

export const id = MEMORY_CORE_WORLD.id;
export const label = MEMORY_CORE_WORLD.label;
export const defaults = MEMORY_CORE_WORLD.defaults;
export const create = MEMORY_CORE_WORLD.create;

export { MEMORY_CORE_WORLD } from './definition.ts';
export default MEMORY_CORE_WORLD;
export { MEMORY_CORE_DEFAULTS, MEMORY_CORE_CONFIG_GROUP, type MemoryCoreConfig } from './config.ts';
