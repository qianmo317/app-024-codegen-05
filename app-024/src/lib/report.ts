// 结算报表：活动结束后向上汇报的汇总计算
// 设计要点：纯函数、无 Date.now/Math.random，所有排序显式指定 —— 同一份数据连续算两次结果必然相同
import type { OnsiteRecord, Riddle, RiddleCategory } from '../types';
import { CATEGORY_LABEL } from '../types';
import { formatDateTime } from './format';
import { stringifyCSV } from './csv';

export type ReportScope = { kind: 'all' } | { kind: 'day'; day: string }; // day = 'YYYY-MM-DD'（本地时区）

export interface ReportEvent {
  title: string;
  host: string;
}

/** 一条登记记录在报表中的展平行（谜条已删除时 no 为 null） */
export interface ReportRecordRow {
  recordId: string;
  riddleId: string;
  no: number | null;
  surface: string;
  winnerName: string;   // '' = 未登记猜中者
  prize: string;        // '' = 未填奖项
  at: number;
  code: string;
  note: string;
}

/** 汇总表一行：谜条数/猜中条数/发放数量 + 复核明细（组成该行的全部登记记录） */
export interface SummaryRow {
  key: string;
  label: string;
  riddles: number | null; // 按奖项汇总不适用 → null
  solved: number;         // 猜中条数（去重后的谜条数）
  prizes: number;         // 发放数量（有奖项的登记条数）
  records: ReportRecordRow[];
}

export interface UnsolvedRow {
  id: string;
  no: number;
  surface: string;
  category: RiddleCategory;
  difficulty: 1 | 2 | 3;
  tags: string[];
}

export interface DupGroup {
  riddleId: string;
  no: number;
  surface: string;
  count: number;        // 登记次数
  extraPrizes: number;  // 多发的奖品份数（组内有奖项的记录数 − 1）
  records: ReportRecordRow[];
}

export interface Report {
  scopeLabel: string;
  overview: {
    totalRiddles: number;
    solvedRiddles: number;   // 范围内被猜中的谜条数（去重，仅限仍在谜库中的谜条）
    unsolvedRiddles: number;
    recordCount: number;     // 范围内登记条数（含指向已删除谜条的记录）
    prizeCount: number;      // 范围内奖品发放数（有奖项的登记条数）
  };
  byPrize: SummaryRow[];
  byCategory: SummaryRow[];
  byDifficulty: SummaryRow[];
  byTag: SummaryRow[];
  unsolved: UnsolvedRow[];          // 范围内没人猜中的谜条（按谜号升序）
  prizeNoWinner: ReportRecordRow[]; // 领了奖却没有登记猜中者的记录
  anomalies: {
    orphanRecords: ReportRecordRow[]; // 指向已删除谜条的登记
    duplicateSolved: DupGroup[];      // 同一谜条被重复登记
    noPrizeRecords: ReportRecordRow[];// 登记了却没填奖项
    notes: string[];                  // 数目对不上的地方（人话说明，顺序固定）
  };
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpRow = (a: ReportRecordRow, b: ReportRecordRow): number => a.at - b.at || cmpStr(a.recordId, b.recordId);

export function scopeLabel(scope: ReportScope): string {
  return scope.kind === 'all' ? '整个活动' : `${scope.day}（单日）`;
}

/** 某一天的起止时间戳 [start, end)，本地时区；非法日期返回 [NaN, NaN]（过滤结果为空） */
export function dayRange(day: string): [number, number] {
  const m = day.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return [NaN, NaN];
  const y = +m[1], mo = +m[2], d = +m[3];
  const start = new Date(y, mo - 1, d).getTime();
  const end = new Date(y, mo - 1, d + 1).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return [NaN, NaN];
  return [start, end];
}

/** 按范围过滤登记记录，并按 (时间, id) 稳定排序 —— 与输入顺序无关 */
export function filterRecords(records: OnsiteRecord[], scope: ReportScope): OnsiteRecord[] {
  const sorted = [...records].sort((a, b) => a.at - b.at || cmpStr(a.id, b.id));
  if (scope.kind === 'all') return sorted;
  const [start, end] = dayRange(scope.day);
  return sorted.filter((r) => r.at >= start && r.at < end);
}

const CATEGORY_ORDER: RiddleCategory[] = ['char', 'object', 'idiom', 'place', 'person', 'other'];
const NO_TAG = '（无标签）';
const NO_PRIZE = '（未填奖项）';

export function buildReport(
  riddles: Riddle[],
  records: OnsiteRecord[],
  scope: ReportScope,
  prizeOrder: string[] = [],
): Report {
  const byId = new Map(riddles.map((r) => [r.id, r]));
  const sortedRiddles = [...riddles].sort((a, b) => a.no - b.no || cmpStr(a.id, b.id));

  const rows: ReportRecordRow[] = filterRecords(records, scope).map((rec) => {
    const r = byId.get(rec.riddleId);
    return {
      recordId: rec.id,
      riddleId: rec.riddleId,
      no: r ? r.no : null,
      surface: r?.surface ?? '',
      winnerName: rec.winnerName ?? '',
      prize: rec.prize ?? '',
      at: rec.at,
      code: rec.code ?? '',
      note: rec.note ?? '',
    };
  });

  const rowsByRiddle = new Map<string, ReportRecordRow[]>();
  for (const row of rows) {
    const arr = rowsByRiddle.get(row.riddleId);
    if (arr) arr.push(row); else rowsByRiddle.set(row.riddleId, [row]);
  }

  const solvedIds = new Set(rows.filter((x) => x.no !== null).map((x) => x.riddleId));
  const hasPrize = (x: ReportRecordRow) => x.prize.trim() !== '';
  const prizeRows = rows.filter(hasPrize);

  const overview = {
    totalRiddles: sortedRiddles.length,
    solvedRiddles: solvedIds.size,
    unsolvedRiddles: sortedRiddles.length - solvedIds.size,
    recordCount: rows.length,
    prizeCount: prizeRows.length,
  };

  // 按谜条维度汇总（谜目/难度/标签共用）：bucketRiddles = 该桶全部谜条
  const summarize = (key: string, label: string, bucketRiddles: Riddle[]): SummaryRow => {
    const recs: ReportRecordRow[] = [];
    let solved = 0;
    for (const r of bucketRiddles) {
      const rs = rowsByRiddle.get(r.id);
      if (rs?.length) { solved++; recs.push(...rs); }
    }
    recs.sort(cmpRow);
    return { key, label, riddles: bucketRiddles.length, solved, prizes: recs.filter(hasPrize).length, records: recs };
  };

  // 一、按奖项（按登记记录的奖项分桶；顺序 = 预设奖项 → 额外奖项（码位序）→ 未填奖项）
  const prizeKeys: string[] = [];
  for (const p of prizeOrder) if (!prizeKeys.includes(p)) prizeKeys.push(p);
  const extraPrizes = [...new Set(rows.map((x) => x.prize).filter((p) => p.trim() !== '' && !prizeKeys.includes(p)))].sort(cmpStr);
  prizeKeys.push(...extraPrizes);
  const byPrize: SummaryRow[] = prizeKeys.map((p) => {
    const recs = rows.filter((x) => x.prize === p).sort(cmpRow);
    return {
      key: `prize:${p}`, label: p, riddles: null,
      solved: new Set(recs.filter((x) => x.no !== null).map((x) => x.riddleId)).size,
      prizes: recs.filter(hasPrize).length,
      records: recs,
    };
  });
  const emptyPrizeRows = rows.filter((x) => !hasPrize(x)).sort(cmpRow);
  if (emptyPrizeRows.length) {
    byPrize.push({
      key: 'prize:', label: NO_PRIZE, riddles: null,
      solved: new Set(emptyPrizeRows.filter((x) => x.no !== null).map((x) => x.riddleId)).size,
      prizes: 0,
      records: emptyPrizeRows,
    });
  }

  // 二、按谜目（固定 6 类顺序）
  const byCategory = CATEGORY_ORDER.map((c) =>
    summarize(`cat:${c}`, CATEGORY_LABEL[c], sortedRiddles.filter((r) => r.category === c)));

  // 三、按难度（1/2/3 星固定顺序）
  const byDifficulty = ([1, 2, 3] as const).map((d) =>
    summarize(`diff:${d}`, `${d} 星`, sortedRiddles.filter((r) => r.difficulty === d)));

  // 四、按标签（一条谜可属多个标签；按谜条数降序、标签名码位序；无标签桶排最后）
  const tagMap = new Map<string, Riddle[]>();
  const noTagRiddles: Riddle[] = [];
  for (const r of sortedRiddles) {
    if (!r.tags.length) { noTagRiddles.push(r); continue; }
    for (const t of r.tags) {
      const arr = tagMap.get(t);
      if (arr) arr.push(r); else tagMap.set(t, [r]);
    }
  }
  const byTag = [...tagMap.keys()]
    .sort((a, b) => tagMap.get(b)!.length - tagMap.get(a)!.length || cmpStr(a, b))
    .map((t) => summarize(`tag:${t}`, t, tagMap.get(t)!));
  if (noTagRiddles.length) byTag.push(summarize('tag:', NO_TAG, noTagRiddles));

  // 五、未猜中谜条（范围内无任何登记）
  const unsolved: UnsolvedRow[] = sortedRiddles
    .filter((r) => !solvedIds.has(r.id))
    .map((r) => ({ id: r.id, no: r.no, surface: r.surface, category: r.category, difficulty: r.difficulty, tags: r.tags }));

  // 六、领了奖却没有登记猜中者
  const prizeNoWinner = prizeRows.filter((x) => !x.winnerName.trim());

  // 七、数目核对（对不上的地方）
  const orphanRecords = rows.filter((x) => x.no === null);
  const duplicateSolved: DupGroup[] = [];
  for (const [rid, rs] of rowsByRiddle) {
    const r = byId.get(rid);
    if (!r || rs.length < 2) continue;
    const prizeCnt = rs.filter(hasPrize).length;
    duplicateSolved.push({
      riddleId: rid, no: r.no, surface: r.surface, count: rs.length,
      extraPrizes: prizeCnt > 0 ? prizeCnt - 1 : 0,
      records: [...rs].sort(cmpRow),
    });
  }
  duplicateSolved.sort((a, b) => a.no - b.no);
  const noPrizeRecords = emptyPrizeRows;

  const notes: string[] = [];
  if (orphanRecords.length) {
    notes.push(`${orphanRecords.length} 条登记指向已删除的谜条：奖品已计入发放数，但不计入猜中条数，也无法归入谜目/难度/标签汇总`);
  }
  if (duplicateSolved.length) {
    const extra = duplicateSolved.reduce((s, g) => s + g.extraPrizes, 0);
    notes.push(`${duplicateSolved.length} 条谜被重复登记（登记条数比猜中条数多的主因）${extra > 0 ? `，多发 ${extra} 份奖` : '，未多发奖'}`);
  }
  if (noPrizeRecords.length) {
    notes.push(`${noPrizeRecords.length} 条登记未填写奖项：登记条数因此比奖品发放数多 ${noPrizeRecords.length}`);
  }
  if (prizeNoWinner.length) {
    notes.push(`${prizeNoWinner.length} 条记录领了奖却没有登记猜中者姓名（见第七节）`);
  }
  if (!notes.length) notes.push('各项数目核对一致，没有发现对不上的地方');

  return {
    scopeLabel: scopeLabel(scope),
    overview,
    byPrize, byCategory, byDifficulty, byTag,
    unsolved, prizeNoWinner,
    anomalies: { orphanRecords, duplicateSolved, noPrizeRecords, notes },
  };
}

/** 汇总行合计（供合计行与复核断言使用） */
export function sumRows(rows: SummaryRow[]): { riddles: number; solved: number; prizes: number } {
  return rows.reduce(
    (acc, r) => ({ riddles: acc.riddles + (r.riddles ?? 0), solved: acc.solved + r.solved, prizes: acc.prizes + r.prizes }),
    { riddles: 0, solved: 0, prizes: 0 },
  );
}

/** 报表 → CSV 文本（内容确定：不含生成时间等易变字段，同一报表导出两次字节一致） */
export function reportToCSV(report: Report, event: ReportEvent): string {
  const rows: (string | number)[][] = [];
  const o = report.overview;
  const noStr = (no: number | null) => (no === null ? '（谜条已删除）' : no);

  rows.push(['结算报表']);
  rows.push(['活动名称', event.title || '（未填写）']);
  rows.push(['主办方', event.host || '（未填写）']);
  rows.push(['统计范围', report.scopeLabel]);
  rows.push([]);

  rows.push(['一、总览']);
  rows.push(['谜条总数', '猜中条数', '剩余未猜中', '登记条数', '奖品发放数']);
  rows.push([o.totalRiddles, o.solvedRiddles, o.unsolvedRiddles, o.recordCount, o.prizeCount]);
  rows.push([]);

  const summarySection = (title: string, headName: string, list: SummaryRow[]) => {
    rows.push([title]);
    rows.push([headName, '谜条数', '猜中条数', '发放数量']);
    if (!list.length) rows.push(['（无）']);
    for (const r of list) rows.push([r.label, r.riddles === null ? '—' : r.riddles, r.solved, r.prizes]);
    if (list.length) {
      const t = sumRows(list);
      rows.push(['合计', list[0].riddles === null ? '—' : t.riddles, t.solved, t.prizes]);
    }
    rows.push([]);
  };
  summarySection('二、按奖项汇总', '奖项', report.byPrize);
  summarySection('三、按谜目汇总', '谜目', report.byCategory);
  summarySection('四、按难度汇总', '难度', report.byDifficulty);
  summarySection('五、按标签汇总', '标签', report.byTag);

  rows.push([`六、没人猜中的谜条（${report.unsolved.length} 条）`]);
  rows.push(['谜号', '谜面', '谜目', '难度', '标签']);
  if (!report.unsolved.length) rows.push(['（无）']);
  for (const u of report.unsolved) {
    rows.push([u.no, u.surface, CATEGORY_LABEL[u.category], `${u.difficulty} 星`, u.tags.join('、')]);
  }
  rows.push([]);

  rows.push([`七、领了奖却没有登记猜中者的记录（${report.prizeNoWinner.length} 条）`]);
  rows.push(['谜号', '谜面', '奖项', '兑奖号码', '登记时间', '备注']);
  if (!report.prizeNoWinner.length) rows.push(['（无）']);
  for (const r of report.prizeNoWinner) {
    rows.push([noStr(r.no), r.surface, r.prize, r.code, formatDateTime(r.at), r.note]);
  }
  rows.push([]);

  rows.push(['八、数目核对']);
  rows.push(['问题', '谜号', '数量', '说明']);
  const a = report.anomalies;
  for (const r of a.orphanRecords) {
    rows.push(['登记指向已删除的谜条', noStr(r.no), 1, `奖项「${r.prize || '未填'}」· ${formatDateTime(r.at)}`]);
  }
  for (const g of a.duplicateSolved) {
    rows.push(['同一谜条重复登记', g.no, g.count, g.extraPrizes > 0 ? `多发 ${g.extraPrizes} 份奖` : '未多发奖']);
  }
  for (const r of a.noPrizeRecords) {
    rows.push(['登记未填奖项', noStr(r.no), 1, `猜中者「${r.winnerName || '匿名'}」· ${formatDateTime(r.at)}`]);
  }
  for (const r of report.prizeNoWinner) {
    rows.push(['领奖未登记猜中者', noStr(r.no), 1, `奖项「${r.prize}」· ${formatDateTime(r.at)}`]);
  }
  if (!a.orphanRecords.length && !a.duplicateSolved.length && !a.noPrizeRecords.length && !report.prizeNoWinner.length) {
    rows.push(['无', '', '', '各项数目核对一致']);
  }

  return stringifyCSV(rows);
}
