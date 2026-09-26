// 结算报表计算测试：范围过滤、四维汇总、未猜中清单、异常核对、确定性（同数据算两次结果相同）
import { describe, it, expect } from 'vitest';
import {
  buildReport, reportToCSV, filterRecords, dayRange, scopeLabel, sumRows,
  type ReportScope,
} from '../src/lib/report';
import type { OnsiteRecord, Riddle } from '../src/types';

// ---- 测试数据工厂 ----
let rid = 0;
function mkRiddle(no: number, over: Partial<Riddle> = {}): Riddle {
  return {
    id: `r${no}`, no, surface: `谜面${no}`, answer: `底${no}`,
    category: 'char', format: 'none', difficulty: 2, tags: [],
    check: { verdict: 'pass', reasons: [], checkedAt: 0 },
    ...over,
  };
}
function mkRec(riddleId: string, at: number, over: Partial<OnsiteRecord> = {}): OnsiteRecord {
  rid += 1;
  return { id: `rec${rid}`, riddleId, prize: '参与奖', at, ...over };
}
/** 本地时区某天某时刻的时间戳 */
function ts(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime();
}

const DAY1 = '2026-02-12';
const DAY2 = '2026-02-13';
const ALL: ReportScope = { kind: 'all' };
const PRIZES = ['参与奖', '三等奖', '二等奖', '一等奖'];

describe('dayRange / scopeLabel / filterRecords', () => {
  it('单日范围 [00:00, 次日00:00)，边界含头不含尾', () => {
    const [start, end] = dayRange(DAY1);
    expect(start).toBe(ts(2026, 2, 12, 0, 0));
    expect(end).toBe(ts(2026, 2, 13, 0, 0));
    const recs = [
      mkRec('a', ts(2026, 2, 11, 23, 59)), // 前一天 → 排除
      mkRec('a', ts(2026, 2, 12, 0, 0)),   // 当天 00:00 → 含
      mkRec('a', ts(2026, 2, 12, 23, 59)), // 当天深夜 → 含
      mkRec('a', ts(2026, 2, 13, 0, 0)),   // 次日 00:00 → 排除
    ];
    const got = filterRecords(recs, { kind: 'day', day: DAY1 });
    expect(got.map((r) => r.at)).toEqual([ts(2026, 2, 12, 0, 0), ts(2026, 2, 12, 23, 59)]);
  });
  it('非法日期过滤结果为空；整个活动不过滤', () => {
    const recs = [mkRec('a', ts(2026, 2, 12))];
    expect(filterRecords(recs, { kind: 'day', day: 'not-a-date' })).toHaveLength(0);
    expect(filterRecords(recs, ALL)).toHaveLength(1);
  });
  it('范围标签', () => {
    expect(scopeLabel(ALL)).toBe('整个活动');
    expect(scopeLabel({ kind: 'day', day: DAY1 })).toBe(`${DAY1}（单日）`);
  });
  it('过滤结果按 (时间, id) 稳定排序，与输入顺序无关', () => {
    const a = mkRec('x', ts(2026, 2, 12, 10));
    const b = mkRec('x', ts(2026, 2, 12, 9));
    const c = mkRec('x', ts(2026, 2, 12, 9)); // 与 b 同时刻，按 id 定序
    const got1 = filterRecords([a, b, c], ALL).map((r) => r.id);
    const got2 = filterRecords([c, a, b], ALL).map((r) => r.id);
    expect(got1).toEqual(got2);
    expect(got1).toEqual([...[b.id, c.id].sort(), a.id]);
  });
});

describe('buildReport 总览与范围', () => {
  const riddles = [
    mkRiddle(1, { category: 'char', difficulty: 1, tags: ['儿童'] }),
    mkRiddle(2, { category: 'idiom', difficulty: 2, tags: ['儿童', '经典'] }),
    mkRiddle(3, { category: 'idiom', difficulty: 3, tags: [] }),
    mkRiddle(4, { category: 'place', difficulty: 3, tags: ['经典'] }),
  ];
  const records = [
    mkRec('r1', ts(2026, 2, 12, 10), { winnerName: '张三', prize: '一等奖' }),
    mkRec('r2', ts(2026, 2, 12, 11), { winnerName: '', prize: '参与奖' }), // 领奖未登记猜中者
    mkRec('r2', ts(2026, 2, 12, 11, 30), { winnerName: '李四', prize: '参与奖' }), // 重复登记
    mkRec('r3', ts(2026, 2, 13, 9), { winnerName: '王五', prize: '' }),            // 次日 + 未填奖项
    mkRec('gone', ts(2026, 2, 12, 12), { winnerName: '赵六', prize: '三等奖' }),   // 谜条已删除
  ];

  it('整个活动：总览五个数', () => {
    const rep = buildReport(riddles, records, ALL, PRIZES);
    expect(rep.scopeLabel).toBe('整个活动');
    expect(rep.overview).toEqual({
      totalRiddles: 4, solvedRiddles: 3, unsolvedRiddles: 1, recordCount: 5, prizeCount: 4,
    });
  });

  it('单日范围：只算当天的登记，两个范围各算一份', () => {
    const d1 = buildReport(riddles, records, { kind: 'day', day: DAY1 }, PRIZES);
    expect(d1.scopeLabel).toBe(`${DAY1}（单日）`);
    expect(d1.overview).toEqual({
      totalRiddles: 4, solvedRiddles: 2, unsolvedRiddles: 2, recordCount: 4, prizeCount: 4,
    });
    const d2 = buildReport(riddles, records, { kind: 'day', day: DAY2 }, PRIZES);
    expect(d2.overview).toEqual({
      totalRiddles: 4, solvedRiddles: 1, unsolvedRiddles: 3, recordCount: 1, prizeCount: 0,
    });
    // 两天的猜中条数之和 = 整个活动（本例两天登记不重叠）
    expect(d1.overview.solvedRiddles + d2.overview.solvedRiddles).toBe(3);
  });

  it('按奖项汇总：预设顺序在前、额外奖项码位序、未填奖项排最后', () => {
    const recs = [
      mkRec('r1', ts(2026, 2, 12, 10), { prize: '一等奖' }),
      mkRec('r2', ts(2026, 2, 12, 11), { prize: '鼓励奖' }),   // 预设外
      mkRec('r3', ts(2026, 2, 12, 12), { prize: '参与奖' }),
      mkRec('r4', ts(2026, 2, 12, 13), { prize: '' }),          // 未填
    ];
    const rep = buildReport(riddles, recs, ALL, PRIZES);
    expect(rep.byPrize.map((r) => r.label)).toEqual(['参与奖', '三等奖', '二等奖', '一等奖', '鼓励奖', '（未填奖项）']);
    const get = (label: string) => rep.byPrize.find((r) => r.label === label)!;
    expect(get('参与奖').prizes).toBe(1);
    expect(get('一等奖').solved).toBe(1);
    expect(get('三等奖').prizes).toBe(0); // 预设奖项没人领也列示
    expect(get('（未填奖项）').prizes).toBe(0);
    expect(get('（未填奖项）').solved).toBe(1);
    // 发放数量合计 = 总览发放数
    expect(sumRows(rep.byPrize).prizes).toBe(rep.overview.prizeCount);
  });

  it('按谜目/难度汇总：固定顺序，合计与总览对账（孤儿记录除外）', () => {
    const rep = buildReport(riddles, records, ALL, PRIZES);
    expect(rep.byCategory.map((r) => r.label)).toEqual(['猜一字', '猜一物', '猜成语', '猜地名', '猜人名', '其他']);
    const idiom = rep.byCategory[2];
    expect(idiom.riddles).toBe(2);   // r2 r3
    expect(idiom.solved).toBe(2);    // r2(当天两条) r3(次日) 都猜中
    expect(idiom.prizes).toBe(2);    // r2 两条参与奖；r3 未填奖项
    expect(rep.byDifficulty.map((r) => r.label)).toEqual(['1 星', '2 星', '3 星']);
    expect(rep.byDifficulty[2].riddles).toBe(2);
    expect(rep.byDifficulty[2].solved).toBe(1); // r3
    // 谜目合计：谜条数=总数、猜中=总览猜中；发放 = 总览发放 − 孤儿记录的奖品
    const catSum = sumRows(rep.byCategory);
    expect(catSum.riddles).toBe(4);
    expect(catSum.solved).toBe(rep.overview.solvedRiddles);
    expect(catSum.prizes).toBe(rep.overview.prizeCount - 1); // gone 的三等奖不在任何谜目桶
  });

  it('按标签汇总：多标签各计一次、按谜条数降序、无标签排最后', () => {
    const rep = buildReport(riddles, records, ALL, PRIZES);
    expect(rep.byTag.map((r) => r.label)).toEqual(['儿童', '经典', '（无标签）']);
    const kids = rep.byTag[0];
    expect(kids.riddles).toBe(2); // r1 r2
    expect(kids.solved).toBe(2);
    expect(kids.prizes).toBe(3);  // 一等奖 + 两条参与奖
    expect(rep.byTag[2].riddles).toBe(1); // r3 无标签
  });

  it('未猜中清单：排除范围内已猜中，按谜号升序', () => {
    const rep = buildReport(riddles, records, ALL, PRIZES);
    expect(rep.unsolved.map((u) => u.no)).toEqual([4]);
    const d1 = buildReport(riddles, records, { kind: 'day', day: DAY1 }, PRIZES);
    expect(d1.unsolved.map((u) => u.no)).toEqual([3, 4]); // r3 次日才猜中
  });

  it('领了奖却没有登记猜中者的记录', () => {
    const rep = buildReport(riddles, records, ALL, PRIZES);
    expect(rep.prizeNoWinner).toHaveLength(1);
    expect(rep.prizeNoWinner[0].riddleId).toBe('r2');
    expect(rep.prizeNoWinner[0].prize).toBe('参与奖');
    // 未填奖项的不算「领了奖」
    const d2 = buildReport(riddles, records, { kind: 'day', day: DAY2 }, PRIZES);
    expect(d2.prizeNoWinner).toHaveLength(0);
  });

  it('数目核对：孤儿记录 / 重复登记 / 未填奖项 / 说明文字', () => {
    const rep = buildReport(riddles, records, ALL, PRIZES);
    expect(rep.anomalies.orphanRecords.map((r) => r.riddleId)).toEqual(['gone']);
    expect(rep.anomalies.duplicateSolved).toHaveLength(1);
    const dup = rep.anomalies.duplicateSolved[0];
    expect(dup.no).toBe(2);
    expect(dup.count).toBe(2);
    expect(dup.extraPrizes).toBe(1); // 两条都有奖项 → 多发 1 份
    expect(rep.anomalies.noPrizeRecords).toHaveLength(1);
    const text = rep.anomalies.notes.join('\n');
    expect(text).toContain('1 条登记指向已删除的谜条');
    expect(text).toContain('1 条谜被重复登记');
    expect(text).toContain('多发 1 份奖');
    expect(text).toContain('1 条登记未填写奖项');
    expect(text).toContain('1 条记录领了奖却没有登记猜中者');
  });

  it('无异常时说明为核对一致', () => {
    const clean = [mkRec('r1', ts(2026, 2, 12, 10), { winnerName: '张三' })];
    const rep = buildReport(riddles, clean, ALL, PRIZES);
    expect(rep.anomalies.notes).toEqual(['各项数目核对一致，没有发现对不上的地方']);
  });

  it('空谜库空登记：各节为零但不报错', () => {
    const rep = buildReport([], [], ALL, PRIZES);
    expect(rep.overview).toEqual({ totalRiddles: 0, solvedRiddles: 0, unsolvedRiddles: 0, recordCount: 0, prizeCount: 0 });
    expect(rep.byCategory).toHaveLength(6);
    expect(rep.byTag).toHaveLength(0);
    expect(rep.unsolved).toHaveLength(0);
  });
});

describe('确定性：同一份数据连续算两次结果必须相同', () => {
  const riddles = [
    mkRiddle(2, { tags: ['b'] }), mkRiddle(1, { tags: ['a', 'b'] }), mkRiddle(3, {}),
  ];
  const records = [
    mkRec('r1', ts(2026, 2, 12, 10), { prize: '一等奖', winnerName: '甲' }),
    mkRec('r2', ts(2026, 2, 12, 9), { prize: '', winnerName: '' }),
    mkRec('r1', ts(2026, 2, 12, 11), { prize: '参与奖', winnerName: '' }),
  ];

  it('buildReport 两次深相等；输入顺序打乱结果不变', () => {
    const rep1 = buildReport(riddles, records, ALL, PRIZES);
    const rep2 = buildReport(riddles, records, ALL, PRIZES);
    expect(rep1).toEqual(rep2);
    const shuffled = buildReport([...riddles].reverse(), [...records].reverse(), ALL, PRIZES);
    expect(shuffled).toEqual(rep1);
  });

  it('reportToCSV 两次输出字节一致', () => {
    const rep = buildReport(riddles, records, ALL, PRIZES);
    const ev = { title: '元宵灯会', host: '××社区工会' };
    const csv1 = reportToCSV(rep, ev);
    const csv2 = reportToCSV(buildReport(riddles, records, ALL, PRIZES), ev);
    expect(csv1).toBe(csv2);
  });
});

describe('reportToCSV 内容', () => {
  it('页眉四行 + 八个栏目齐全，数字与计算结果一致', () => {
    const riddles = [mkRiddle(1, { category: 'char' }), mkRiddle(2, { category: 'idiom', tags: ['经典'] })];
    const records = [
      mkRec('r1', ts(2026, 2, 12, 10), { winnerName: '', prize: '一等奖', code: 'DJ-0001' }),
      mkRec('gone', ts(2026, 2, 12, 11), { prize: '参与奖' }),
    ];
    const rep = buildReport(riddles, records, { kind: 'day', day: DAY1 }, PRIZES);
    const csv = reportToCSV(rep, { title: '元宵灯会', host: '××社区工会' });
    expect(csv).toContain('结算报表');
    expect(csv).toContain('活动名称,元宵灯会');
    expect(csv).toContain('主办方,××社区工会');
    expect(csv).toContain(`统计范围,${DAY1}（单日）`);
    for (const sec of ['一、总览', '二、按奖项汇总', '三、按谜目汇总', '四、按难度汇总', '五、按标签汇总', '六、没人猜中的谜条', '七、领了奖却没有登记猜中者的记录', '八、数目核对']) {
      expect(csv).toContain(sec);
    }
    expect(csv).toContain('2,1,1,2,2'); // 总览行
    expect(csv).toContain('一等奖,—,1,1'); // 奖项行
    expect(csv).toContain('（谜条已删除）'); // 孤儿记录
    expect(csv).toContain('领奖未登记猜中者,1,1');
    expect(csv).toContain('DJ-0001');
  });

  it('空报表各节显示（无）且核对一致', () => {
    const rep = buildReport([], [], ALL, []);
    const csv = reportToCSV(rep, { title: '', host: '' });
    expect(csv).toContain('活动名称,（未填写）');
    expect(csv).toContain('0,0,0,0,0');
    expect(csv).toContain('无,,,各项数目核对一致');
  });
});
