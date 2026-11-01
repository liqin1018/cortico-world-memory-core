/** 角色自己的状态推进：精力随时间掉、睡觉回血、心情缓慢回归平静。 */
import type { MemoryCoreConfig } from './config.ts';
import type { CoreState } from './store.ts';
import { inWindow, localParts } from './time.ts';

export function createInitialState(now: Date, tz: string, cfg: MemoryCoreConfig): CoreState {
  const p = localParts(now, tz);
  const sleeping = inWindow(p.minutes, cfg.sleepStart, cfg.sleepEnd);
  const iso = now.toISOString();
  return {
    energy: sleeping ? 68 : 74,
    mood: 62,
    activity: sleeping ? '睡觉' : '发呆',
    location: '房间',
    sleeping,
    createdAt: iso,
    updatedAt: iso,
  };
}

/** 原地推进；返回是否有变化。 */
export function advance(state: CoreState, now: Date, tz: string, cfg: MemoryCoreConfig): boolean {
  const p = localParts(now, tz);
  const last = Date.parse(state.updatedAt);
  const hours = Math.min(12, Math.max(0, (now.getTime() - (Number.isFinite(last) ? last : now.getTime())) / 3_600_000));
  const before = `${state.energy.toFixed(1)}|${state.mood.toFixed(1)}|${state.sleeping}|${state.activity}|${state.location}`;
  const shouldSleep = inWindow(p.minutes, cfg.sleepStart, cfg.sleepEnd);

  if (shouldSleep) {
    if (!state.sleeping) {
      state.sleeping = true;
      state.activity = '睡觉';
    }
    state.energy = Math.min(100, state.energy + hours * 9);
    state.mood = Math.min(100, state.mood + hours * 0.5);
  } else {
    if (state.sleeping) {
      state.sleeping = false;
      state.activity = '刚醒';
    }
    state.energy = Math.max(6, state.energy - hours * Math.max(0, cfg.energyDecayPerHour));
    state.mood = state.mood + (58 - state.mood) * Math.min(0.5, hours * 0.12);
  }
  state.updatedAt = now.toISOString();
  return before !== `${state.energy.toFixed(1)}|${state.mood.toFixed(1)}|${state.sleeping}|${state.activity}|${state.location}`;
}

export function moodLabel(mood: number): string {
  if (mood >= 78) return '很好';
  if (mood >= 62) return '还行';
  if (mood >= 45) return '一般';
  if (mood >= 30) return '有点低落';
  return '很难过';
}
