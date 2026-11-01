/**
 * 临时验证：退休/恢复/改版/合并/重复/作废/垃圾/血缘。
 * 跑法：node --experimental-transform-types tools/test-store.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'mcore-'));
const store = new CardStore(dir);

const a = store.add({ kind: 'fact', text: '主人让我叫他月，我们现在是私聊一对一的搭子关系。', weight: 0.8 }).card;
const b = store.add({ kind: 'fact', text: '约好明早七点二十叫他起床，闹钟我记着。', weight: 0.6 }).card;
const c = store.add({ kind: 'fact', text: '取消了，改到十点叫他，七点二十不用了，让他多睡一会儿。', weight: 0.6 }).card;
const j = store.add({ kind: 'note', text: '[取消]' }).card;
const d = store.add({ kind: 'episode', text: '今早六人局狼人杀，摆桌的鲸鱼姬自己没来，五个到场的白等一场。', weight: 0.5 }).card;

console.log('1) 初始：', store.stats().total, '在用 /', store.stats().retired, '退休');

const r1 = store.retire(d.id, 'manual');
console.log('2) 退休一条 →', r1?.status, '| 在用', store.stats().total, '退休', store.stats().retired, '| active 含它?', store.active().some((x) => x.id === d.id));

store.restore(d.id);
console.log('3) 恢复 →', store.find(d.id)?.status, '| 在用', store.stats().total);

const fresh = store.revise(b.id, '约好明早十点叫他起床（原七点二十取消），闹钟我记着。');
console.log('4) 改版 → 新卡', fresh?.id.slice(0, 8), '| 旧卡状态', store.find(b.id)?.status, '| 新卡接替', fresh?.supersedes?.length);

const lin = store.lineage(fresh!.id);
console.log('5) 血缘 → 接替了', lin.supersedes.map((x) => x.text.slice(0, 10)), '| 被接替', lin.replacedBy?.text.slice(0, 10) ?? '无');

const stale = store.stale();
console.log('6) 疑似作废 →', stale.length, stale.map((x) => x.text.slice(0, 12)));
const junk = store.junk();
console.log('7) 垃圾 →', junk.length, junk.map((x) => x.text));

const dupA = store.add({ kind: 'fact', text: '主人很喜欢被夸奖，不喜欢被忽视。', weight: 0.5 }).card;
const dupB = store.add({ kind: 'fact', text: '主人很喜欢被夸奖，不喜欢被忽视。', weight: 0.7 }).card;
console.log('8) 完全同文 → 合并?', dupA.id === dupB.id, '| 权重', store.find(dupA.id)?.weight);

const dupC = store.add({ kind: 'fact', text: '主人很喜欢被夸奖，也不太喜欢被忽视。', weight: 0.5 }).card;
const groups = store.duplicates();
console.log('9) 相似分组 →', groups.length, groups.map((g) => g.cards.length + '@' + g.score));

const merged = store.merge(dupA.id, [dupC.id]);
console.log('10) 合并 →', merged.merged, '| keep 的 supersedes', store.find(dupA.id)?.supersedes?.length, '| drop 状态', store.find(dupC.id)?.status);

console.log('11) 最终 → 在用', store.stats().total, '退休', store.stats().retired, '| scopes', store.scopes());

rmSync(dir, { recursive: true, force: true });
