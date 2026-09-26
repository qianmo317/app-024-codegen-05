// 结算报表引擎测试：汇总正确性 / 范围切换 / 确定性（连续两次结果相同）/ 导出内容
import { describe, it, expect } from 'vitest';
import { buildReport, reportToCSV, recordDays, dayKey, type AggRow, type ReportScope } from '../src/lib/report';
import type { OnsiteRecord, Riddle, RiddleCategory } from '../src/types';

// 本地时区固定两天（避免依赖 UTC 换算）
const D1 = new Date(2026, 1, 15, 10, 0, 0).getTime();  // 2026-02-15 10:00
const D1b = new Date(2026, 1, 15, 18, 30, 0).getTime(); // 2026-02-15 18:30
const D2 = new Date(2026, 1, 16, 9, 0, 0).getTime();   // 2026-02-16 09:00
const DAY1 = dayKey(D1); // '2026-02-15'
const DAY2 = dayKey(D2); // '2026-02-16'

const ALL: ReportScope = { kind: 'all' };
const PRIZES = ['参与奖', '三等奖', '二等奖', '一等奖'];

function mkRiddle(no: number, category: RiddleCategory, difficulty: 1 | 2 | 3, tags: string[] = []): Riddle {
  return {
    id: `r${no}`, no, surface: `谜面${no}`, answer: `底${no}`, category, format: 'none',
    difficulty, tags, check: { verdict: 'pass', reasons: [], checkedAt: 0 },
  };
}

function mkRec(id: string, riddleId: string, at: number, prize: string, winnerName?: string): OnsiteRecord {
  return { id, riddleId, at, prize, winnerName };
}

// r1 字谜★[儿童] / r2 成语★★[儿童,经典] / r3 字谜★★★[] / r4 地名★★[经典]
const riddles: Riddle[] = [
  mkRiddle(1, 'char', 1, ['儿童']),
  mkRiddle(2, 'idiom', 2, ['儿童', '经典']),
  mkRiddle(3, 'char', 3),
  mkRiddle(4, 'place', 2, ['经典']),
];

const records: OnsiteRecord[] = [
  mkRec('a1', 'r1', D1, '一等奖', '张三'),
  mkRec('a2', 'r2', D1, '参与奖'),              // 领奖未登记猜中者
  mkRec('a3', 'r2', D1b, '参与奖', '李四'),      // 与 a2 同一谜号 → 重复登记
  mkRec('a4', 'r3', D2, '', '王五'),             // 未填奖项
  mkRec('a5', 'ghost', D2, '二等奖'),            // 谜号对不上 + 未登记猜中者
];

const rowOf = (rows: AggRow[], key: string) => rows.find((r) => r.key === key)!;

describe('buildReport · 整个活动', () => {
  const rep = buildReport(riddles, records, ALL, { prizeNames: PRIZES });

  it('总量指标', () => {
    expect(rep.totalRiddles).toBe(4);
    expect(rep.solved).toBe(3);          // r1、r2、r3
    expect(rep.unsolved).toBe(1);        // r4
    expect(rep.recordsInScope).toBe(5);
    expect(rep.validRecords).toBe(4);    // 排除 ghost
    expect(rep.issued).toBe(3);          // 一等奖 + 参与奖×2（a4 未填奖项不计）
    expect(rep.scopeLabel).toBe('整个活动');
  });

  it('按奖项汇总（含 0 发放的预设奖项，顺序跟随设置）', () => {
    expect(rep.byPrize.map((r) => r.key)).toEqual(PRIZES);
    const join = rowOf(rep.byPrize, '参与奖');
    expect(join.issued).toBe(2);
    expect(join.solved).toBe(1);         // 同一谜号 r2 去重
    expect(join.issuedNos).toEqual([2, 2]);
    expect(join.solvedNos).toEqual([2]);
    const first = rowOf(rep.byPrize, '一等奖');
    expect(first.issued).toBe(1);
    expect(first.solvedNos).toEqual([1]);
    expect(rowOf(rep.byPrize, '二等奖').issued).toBe(0); // ghost 不计入
    expect(rowOf(rep.byPrize, '三等奖').issued).toBe(0);
  });

  it('按谜目汇总（六类齐全、含 0）', () => {
    expect(rep.byCategory.map((r) => r.key)).toEqual(['猜一字', '猜一物', '猜成语', '猜地名', '猜人名', '其他']);
    const char = rowOf(rep.byCategory, '猜一字');
    expect(char.total).toBe(2);
    expect(char.solved).toBe(2);
    expect(char.issued).toBe(1);         // 仅 r1 的一等奖；r3 未填奖项
    const idiom = rowOf(rep.byCategory, '猜成语');
    expect(idiom.total).toBe(1);
    expect(idiom.solved).toBe(1);
    expect(idiom.issued).toBe(2);
    expect(rowOf(rep.byCategory, '猜地名').solved).toBe(0);
    expect(rep.byCategory.reduce((s, r) => s + (r.total ?? 0), 0)).toBe(4);
  });

  it('按难度汇总', () => {
    const d1 = rep.byDifficulty[0];
    expect(d1.total).toBe(1);
    expect(d1.solved).toBe(1);
    expect(d1.issued).toBe(1);
    const d2 = rep.byDifficulty[1];
    expect(d2.total).toBe(2);            // r2、r4
    expect(d2.solved).toBe(1);
    expect(d2.issued).toBe(2);
    const d3 = rep.byDifficulty[2];
    expect(d3.total).toBe(1);
    expect(d3.solved).toBe(1);
    expect(d3.issued).toBe(0);           // r3 未填奖项
  });

  it('按标签汇总（多标签分别计入，按总数/猜中排序）', () => {
    expect(rep.byTag.map((r) => r.key)).toEqual(['儿童', '经典']);
    const kid = rowOf(rep.byTag, '儿童');
    expect(kid.total).toBe(2);
    expect(kid.solved).toBe(2);
    expect(kid.issued).toBe(3);          // r1 一等奖 + r2 参与奖×2
    const classic = rowOf(rep.byTag, '经典');
    expect(classic.total).toBe(2);
    expect(classic.solved).toBe(1);
    expect(classic.issued).toBe(2);
  });

  it('未猜中谜条（按谜号排序）', () => {
    expect(rep.unsolvedRiddles.map((u) => u.no)).toEqual([4]);
    expect(rep.unsolvedRiddles[0].surface).toBe('谜面4');
  });

  it('领奖未登记猜中者（含谜号对不上的记录，按时间排序）', () => {
    expect(rep.noWinnerRecords).toHaveLength(2);
    expect(rep.noWinnerRecords[0]).toMatchObject({ no: 2, prize: '参与奖' });
    expect(rep.noWinnerRecords[1]).toMatchObject({ no: null, prize: '二等奖' });
  });

  it('数目核对：孤儿 / 重复 / 缺猜中者 / 未填奖项', () => {
    const kinds = rep.issues.map((i) => i.kind);
    expect(kinds).toContain('orphan');
    expect(kinds).toContain('duplicate');
    expect(kinds.filter((k) => k === 'no-winner')).toHaveLength(2);
    expect(kinds).toContain('no-prize');
    // 发放 3 == 猜中 3 → 不报数目不一致
    expect(kinds).not.toContain('count-mismatch');
    const dup = rep.issues.find((i) => i.kind === 'duplicate')!;
    expect(dup.text).toContain('谜号 2');
    expect(dup.text).toContain('2 次');
  });
});

describe('buildReport · 指定某一天', () => {
  it('第一天：只算当天登记，跨天猜中的谜条仍属未猜中', () => {
    const rep = buildReport(riddles, records, { kind: 'day', day: DAY1 }, { prizeNames: PRIZES });
    expect(rep.scopeLabel).toBe(`${DAY1} 当日`);
    expect(rep.recordsInScope).toBe(3);
    expect(rep.solved).toBe(2);                    // r1、r2；r3 是第二天猜中的
    expect(rep.unsolvedRiddles.map((u) => u.no)).toEqual([3, 4]);
    expect(rep.issued).toBe(3);
    expect(rep.noWinnerRecords.map((n) => n.no)).toEqual([2]);
    // 发放 3 ≠ 猜中 2 → 数目不一致提示
    const mismatch = rep.issues.find((i) => i.kind === 'count-mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.text).toContain('3');
    expect(mismatch!.text).toContain('2');
  });

  it('第二天：含谜号对不上的登记', () => {
    const rep = buildReport(riddles, records, { kind: 'day', day: DAY2 }, { prizeNames: PRIZES });
    expect(rep.recordsInScope).toBe(2);
    expect(rep.validRecords).toBe(1);
    expect(rep.orphanRecords).toHaveLength(1);
    expect(rep.solved).toBe(1);
    expect(rep.issued).toBe(0);                    // a4 未填奖项；a5 是孤儿不计
    expect(rep.unsolvedRiddles.map((u) => u.no)).toEqual([1, 2, 4]);
    expect(rep.noWinnerRecords).toHaveLength(1);
    expect(rep.noWinnerRecords[0].no).toBeNull();
    const kinds = rep.issues.map((i) => i.kind);
    expect(kinds).toContain('orphan');
    expect(kinds).toContain('no-prize');
    expect(kinds).toContain('count-mismatch');     // 0 ≠ 1
  });

  it('没有登记的日期：全部未猜中、各项为零', () => {
    const rep = buildReport(riddles, records, { kind: 'day', day: '2026-02-14' });
    expect(rep.recordsInScope).toBe(0);
    expect(rep.solved).toBe(0);
    expect(rep.issued).toBe(0);
    expect(rep.unsolvedRiddles).toHaveLength(4);
    expect(rep.issues).toEqual([]);
  });
});

describe('buildReport · 确定性', () => {
  it('同一份输入连续算两次，结果完全相同', () => {
    const a = buildReport(riddles, records, ALL, { prizeNames: PRIZES });
    const b = buildReport(riddles, records, ALL, { prizeNames: PRIZES });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('输入顺序打乱，结果不变（排序稳定）', () => {
    const base = buildReport(riddles, records, ALL, { prizeNames: PRIZES });
    const shuffledRiddles = [...riddles].reverse();
    const shuffledRecords = [...records].reverse();
    const out = buildReport(shuffledRiddles, shuffledRecords, ALL, { prizeNames: PRIZES });
    expect(JSON.stringify(out)).toBe(JSON.stringify(base));
  });

  it('空数据不报错、全部为零', () => {
    const rep = buildReport([], [], ALL);
    expect(rep.totalRiddles).toBe(0);
    expect(rep.solved).toBe(0);
    expect(rep.issued).toBe(0);
    expect(rep.unsolvedRiddles).toEqual([]);
    expect(rep.noWinnerRecords).toEqual([]);
    expect(rep.issues).toEqual([]);
    expect(rep.byCategory).toHaveLength(6);
    expect(rep.byDifficulty).toHaveLength(3);
  });

  it('recordDays 去重排序', () => {
    expect(recordDays(records)).toEqual([DAY1, DAY2]);
  });
});

describe('reportToCSV · 导出单个文件', () => {
  const meta = { title: '元宵灯会', host: '××社区工会' };

  it('包含页眉信息与全部栏目', () => {
    const rep = buildReport(riddles, records, ALL, { prizeNames: PRIZES });
    const csv = reportToCSV(rep, meta);
    expect(csv.charCodeAt(0)).toBe(0xfeff);        // UTF-8 BOM
    for (const s of ['元宵灯会', '××社区工会', '整个活动',
      '一、汇总', '二、按奖项汇总', '三、按谜目汇总', '四、按难度汇总', '五、按标签汇总',
      '六、始终没人猜中的谜条', '七、领了奖却没有登记猜中者的记录', '八、数目核对']) {
      expect(csv).toContain(s);
    }
    expect(csv).toContain('谜面4');                // 未猜中清单
    expect(csv).toContain('参与奖,2,1');           // 奖项行：发放 2、猜中 1
  });

  it('同一范围连续导出两次，内容字节一致', () => {
    const rep1 = buildReport(riddles, records, ALL, { prizeNames: PRIZES });
    const rep2 = buildReport(riddles, records, ALL, { prizeNames: PRIZES });
    expect(reportToCSV(rep1, meta)).toBe(reportToCSV(rep2, meta));
  });

  it('范围写入文件内容：某日报表含当日标识', () => {
    const rep = buildReport(riddles, records, { kind: 'day', day: DAY1 }, { prizeNames: PRIZES });
    const csv = reportToCSV(rep, meta);
    expect(csv).toContain(`${DAY1} 当日`);
    expect(csv).toContain('谜面3');                // 第二天才猜中 → 当日属未猜中
    expect(csv).not.toContain('谜面1');            // 当天已猜中 → 不在未猜中清单
  });

  it('无异常时核对区给出明确结论', () => {
    const clean = buildReport([mkRiddle(1, 'char', 1)], [mkRec('x', 'r1', D1, '参与奖', '张三')], ALL);
    expect(clean.issues).toEqual([]);
    expect(reportToCSV(clean, meta)).toContain('未发现对不上的地方');
  });
});
