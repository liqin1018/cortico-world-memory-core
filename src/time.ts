/** 时区与时间窗的纯函数；不碰文件，便于单测。 */

export interface LocalParts {
  /** YYYY-MM-DD */
  date: string;
  hour: number;
  minute: number;
  /** 当天 0 点起的分钟数 */
  minutes: number;
}

export function localParts(now: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

export function formatLocal(iso: string | number | Date, tz: string): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = localParts(d, tz);
  return `${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** "21:30" → 1290；非法返回 null。 */
export function hmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 时间窗判定，支持跨零点。
 * 起止相同视为不启用（返回 false）——很多插件的坑就在这。
 */
export function inWindow(minutes: number, start: string, end: string): boolean {
  const a = hmToMinutes(start);
  const b = hmToMinutes(end);
  if (a === null || b === null || a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/** 距离窗口结束还有多少分钟（不在窗内返回 0）。 */
export function minutesUntilWindowEnd(minutes: number, start: string, end: string): number {
  const a = hmToMinutes(start);
  const b = hmToMinutes(end);
  if (a === null || b === null || a === b) return 0;
  if (!inWindow(minutes, start, end)) return 0;
  return (b - minutes + 1440) % 1440;
}

export function humanSpan(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}
