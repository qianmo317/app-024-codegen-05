// 活动结算报表引擎：纯函数 + 固定排序，同一份输入连续算两次结果必然相同
// 汇总维度：奖项 / 谜目 / 难度 / 标签；并给出未猜中谜条、领奖未登记猜中者、数目核对
import type { OnsiteRecord, Riddle, RiddleCategory } from '../types';
import { CATEGORY_LABEL } from '../types';
import { formatDateTime } from './format';
import { stringifyCSV, withBOM } from './csv';

export type ReportScope =
  | { kind: 'all' }
  | { kind: 'day'; day: string }; // YYYY-MM-DD，按浏览器本地时区

export interface AggRow {
  key: string;             // 维度名称（奖项名 / 谜目名 / 难度名 / 标签名）
  total: number | null;    // 该维度谜条总数（按奖项维度无意义 → null）
  solved: number;          // 猜中条数（不同谜号去重）
  issued: number;          // 奖品发放数量（奖项非空的登记条数，重复发奖不去重）
  solvedNos: number[];     // 猜中谜号明细（复核用，按谜号排序）
  issuedNos: number[];     // 发奖对应谜号明细（复核用，不去重，按谜号排序）
}

export type IssueKind = 'orphan' | 'duplicate' | 'no-winner' | 'no-prize' | 'count-mismatch';

export interface ReportIssue {
  kind: IssueKind;
  text: string;
}

export interface UnsolvedRiddle {
  no: number;
  surface: string;
  category: RiddleCategory;
  difficulty: 1 | 2 | 3;
  tags: string[];
}

export interface NoWinnerRow {
  id: string;
  no: number | null;       // null = 登记的谜条已不在谜库（谜号对不上）
  prize: string;
  code?: string;
  at: number;
}

export interface OrphanRow {
  id: string;
  riddleId: string;
  winnerName?: string;
  prize: string;
  at: number;
}

export interface SettlementReport {
  scope: ReportScope;
  scopeLabel: string;
  totalRiddles: number;
  solved: number;          // 范围内猜中谜条数（有效登记、按谜条去重）
  unsolved: number;
  recordsInScope: number;  // 范围内登记记录总数（含谜号对不上的）
  validRecords: number;    // 谜号对得上的登记数
  issued: number;          // 奖品发放总数（有效登记、奖项非空）
  byPrize: AggRow[];
  byCategory: AggRow[];
  byDifficulty: AggRow[];
  byTag: AggRow[];
  unsolvedRiddles: UnsolvedRiddle[];
  noWinnerRecords: NoWinnerRow[];
  orphanRecords: OrphanRow[];
  issues: ReportIssue[];
}

export const ISSUE_LABEL: Record<IssueKind, string> = {
  orphan: '谜号对不上',
  duplicate: '重复登记',
  'no-winner': '缺猜中者',
  'no-prize': '未填奖项',
  'count-mismatch': '数目不一致',
};

/** 时间戳 → 本地日期 YYYY-MM-DD */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function scopeLabel(scope: ReportScope): string {
  return scope.kind === 'all' ? '整个活动' : `${scope.day} 当日`;
}

/** 范围内出现过登记的日期（供页面快捷选择，已去重排序） */
export function recordDays(records: OnsiteRecord[]): string[] {
  return Array.from(new Set(records.map((r) => dayKey(r.at)))).sort();
}

/** 确定性比较：数字升序，平手按字符串码点（不依赖运行环境 locale） */
function byNoThenId(a: { no: number; id: string }, b: { no: number; id: string }): number {
  return a.no - b.no || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface Bucket {
  key: string;
  ids: Set<string>;
}

function emptyRow(key: string, total: number | null): AggRow {
  return { key, total, solved: 0, issued: 0, solvedNos: [], issuedNos: [] };
}

/**
 * 计算结算报表。纯函数：只依赖 riddles / records / scope / 奖项顺序，
 * 不读时钟、不依赖全局状态；所有输出列表均有固定排序，重复计算结果一致。
 */
export function buildReport(
  riddles: Riddle[],
  records: OnsiteRecord[],
  scope: ReportScope,
  options?: { prizeNames?: string[] },
): SettlementReport {
  // 1) 范围过滤（全部活动 / 某一天，按本地日期）
  const inScope = records.filter((r) => scope.kind === 'all' || dayKey(r.at) === scope.day);
  const sortedRecs = [...inScope].sort((a, b) =>
    a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedRiddles = [...riddles].sort(byNoThenId);
  const byId = new Map(sortedRiddles.map((r) => [r.id, r]));

  // 2) 分出有效登记与谜号对不上的登记（孤儿记录不计入任何汇总，只在核对区列出）
  const orphans: OrphanRow[] = [];
  const valid: OnsiteRecord[] = [];
  for (const rec of sortedRecs) {
    if (byId.has(rec.riddleId)) valid.push(rec);
    else orphans.push({ id: rec.id, riddleId: rec.riddleId, winnerName: rec.winnerName, prize: rec.prize, at: rec.at });
  }

  // 3) 谜条 → 登记列表；猜中谜条集合（按谜条去重）
  const recsByRiddle = new Map<string, OnsiteRecord[]>();
  for (const rec of valid) {
    const arr = recsByRiddle.get(rec.riddleId) ?? [];
    arr.push(rec);
    recsByRiddle.set(rec.riddleId, arr);
  }
  const solvedIds = new Set(valid.map((r) => r.riddleId));
  const solved = solvedIds.size;
  const issued = valid.filter((r) => r.prize.trim() !== '').length;

  const noOf = (id: string) => byId.get(id)!.no;
  const sortedNos = (ids: Iterable<string>) => Array.from(ids, noOf).sort((a, b) => a - b);

  // 4) 按谜条分桶汇总（谜目 / 难度 / 标签通用）
  const bucketRows = (buckets: Bucket[]): AggRow[] =>
    buckets.map((b) => {
      const row = emptyRow(b.key, b.ids.size);
      const issuedIds: number[] = [];
      for (const id of b.ids) {
        const recs = recsByRiddle.get(id);
        if (!recs) continue;
        row.solvedNos.push(noOf(id));
        for (const rec of recs) {
          if (rec.prize.trim() !== '') issuedIds.push(noOf(id));
        }
      }
      row.solvedNos.sort((a, b) => a - b);
      issuedIds.sort((a, b) => a - b);
      row.issuedNos = issuedIds;
      row.solved = row.solvedNos.length;
      row.issued = issuedIds.length;
      return row;
    });

  // 谜目：固定六类顺序，含 0 条的维度，便于逐项核对合计
  const CATEGORY_ORDER: RiddleCategory[] = ['char', 'object', 'idiom', 'place', 'person', 'other'];
  const catBuckets: Bucket[] = CATEGORY_ORDER.map((c) => ({
    key: CATEGORY_LABEL[c],
    ids: new Set(sortedRiddles.filter((r) => r.category === c).map((r) => r.id)),
  }));
  const byCategory = bucketRows(catBuckets);

  // 难度：固定一星~三星
  const diffBuckets: Bucket[] = [1, 2, 3].map((d) => ({
    key: `${'★'.repeat(d)}${'☆'.repeat(3 - d)}（${d} 星）`,
    ids: new Set(sortedRiddles.filter((r) => r.difficulty === d).map((r) => r.id)),
  }));
  const byDifficulty = bucketRows(diffBuckets);

  // 标签：同一谜条可挂多个标签，会同时进入多个桶（合计可能大于总数，属正常）
  const tagIds = new Map<string, Set<string>>();
  for (const r of sortedRiddles) {
    for (const t of r.tags) {
      if (!tagIds.has(t)) tagIds.set(t, new Set());
      tagIds.get(t)!.add(r.id);
    }
  }
  const byTag = bucketRows(Array.from(tagIds, ([key, ids]) => ({ key, ids })))
    .sort((a, b) => b.total! - a.total! || b.solved - a.solved || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // 5) 按奖项：以设置中的奖项顺序为先导（含发放 0 的奖项），其余按名称码点序追加
  const prizeOrder = Array.from(new Set(options?.prizeNames ?? []));
  const prizeSeen = new Set<string>();
  const prizeNames: string[] = [];
  for (const p of prizeOrder) { if (!prizeSeen.has(p)) { prizeSeen.add(p); prizeNames.push(p); } }
  const extraPrizes = Array.from(new Set(valid.map((r) => r.prize.trim()).filter(Boolean)))
    .filter((p) => !prizeSeen.has(p))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  prizeNames.push(...extraPrizes);

  const byPrize = prizeNames.map((name) => {
    const row = emptyRow(name, null);
    const idSet = new Set<string>();
    for (const rec of valid) {
      if (rec.prize.trim() !== name) continue;
      row.issued += 1;
      row.issuedNos.push(noOf(rec.riddleId));
      idSet.add(rec.riddleId);
    }
    row.issuedNos.sort((a, b) => a - b);
    row.solvedNos = sortedNos(idSet);
    row.solved = row.solvedNos.length;
    return row;
  });

  // 6) 未猜中谜条（范围内无任何有效登记），按谜号排序
  const unsolvedRiddles: UnsolvedRiddle[] = sortedRiddles
    .filter((r) => !solvedIds.has(r.id))
    .map((r) => ({ no: r.no, surface: r.surface, category: r.category, difficulty: r.difficulty, tags: r.tags }));

  // 7) 领了奖却没有登记猜中者姓名（含谜号对不上的记录）
  const noWinnerRecords: NoWinnerRow[] = [];
  for (const rec of sortedRecs) {
    if (rec.prize.trim() !== '' && !(rec.winnerName ?? '').trim()) {
      noWinnerRecords.push({
        id: rec.id, no: byId.get(rec.riddleId)?.no ?? null,
        prize: rec.prize, code: rec.code, at: rec.at,
      });
    }
  }

  // 8) 数目核对（各类内部按谜号/时间确定性排序）
  const issues: ReportIssue[] = [];
  for (const o of orphans) {
    issues.push({
      kind: 'orphan',
      text: `登记记录「${o.prize || '未填奖项'} · ${formatDateTime(o.at)}」对应的谜条在谜库中找不到（谜条可能已删除），该记录未计入上方汇总`,
    });
  }
  const dupRiddles = sortedRiddles.filter((r) => (recsByRiddle.get(r.id)?.length ?? 0) > 1);
  for (const r of dupRiddles) {
    const n = recsByRiddle.get(r.id)!.length;
    issues.push({ kind: 'duplicate', text: `谜号 ${r.no}「${r.surface}」在本范围内被登记 ${n} 次，请核对是否重复发奖` });
  }
  for (const nw of noWinnerRecords) {
    issues.push({
      kind: 'no-winner',
      text: nw.no != null
        ? `谜号 ${nw.no} 发出「${nw.prize}」但未登记猜中者姓名（${formatDateTime(nw.at)}）`
        : `一条「${nw.prize}」发奖记录（${formatDateTime(nw.at)}）既未登记猜中者、谜条也已不在谜库`,
    });
  }
  for (const rec of valid) {
    if (rec.prize.trim() === '') {
      issues.push({ kind: 'no-prize', text: `谜号 ${noOf(rec.riddleId)} 有猜中登记但未填写奖项（${formatDateTime(rec.at)}）` });
    }
  }
  if (issued !== solved) {
    const diff = issued - solved;
    issues.push({
      kind: 'count-mismatch',
      text: `奖品发放 ${issued} 份与猜中条数 ${solved} 条不一致（差 ${diff > 0 ? `+${diff}` : diff}），请核对重复登记与未填奖项记录`,
    });
  }

  return {
    scope,
    scopeLabel: scopeLabel(scope),
    totalRiddles: sortedRiddles.length,
    solved,
    unsolved: unsolvedRiddles.length,
    recordsInScope: sortedRecs.length,
    validRecords: valid.length,
    issued,
    byPrize,
    byCategory,
    byDifficulty,
    byTag,
    unsolvedRiddles,
    noWinnerRecords,
    orphanRecords: orphans,
    issues,
  };
}

// ---------------- 导出（单个 CSV 文件，UTF-8 BOM） ----------------

export interface ReportMeta {
  title: string;
  host: string;
}

const nosText = (nos: number[]) => nos.join('、');

/** 报表导出为 CSV 文本（不含 BOM）；内容不含生成时刻，同数据重复导出字节一致 */
export function reportToCSV(rep: SettlementReport, meta: ReportMeta): string {
  const rows: (string | number)[][] = [];
  rows.push(['结算报表']);
  rows.push(['活动名称', meta.title || '（未填写）']);
  rows.push(['主办方', meta.host || '（未填写）']);
  rows.push(['统计范围', rep.scopeLabel]);
  rows.push([]);
  rows.push(['一、汇总']);
  rows.push(['指标', '数值']);
  rows.push(['谜条总数', rep.totalRiddles]);
  rows.push(['猜中条数', rep.solved]);
  rows.push(['未猜中条数', rep.unsolved]);
  rows.push(['奖品发放数量', rep.issued]);
  rows.push(['登记记录数', rep.recordsInScope]);
  rows.push(['其中谜号对不上的记录', rep.orphanRecords.length]);
  rows.push(['领奖未登记猜中者的记录', rep.noWinnerRecords.length]);
  rows.push([]);

  rows.push(['二、按奖项汇总']);
  rows.push(['奖项', '发放数量', '猜中条数', '发奖谜号明细（复核）']);
  for (const r of rep.byPrize) rows.push([r.key, r.issued, r.solved, nosText(r.issuedNos)]);
  rows.push(['合计', rep.issued, rep.solved, '']);
  rows.push([]);

  const dimRows = (title: string, dimName: string, list: AggRow[]) => {
    rows.push([title]);
    rows.push([dimName, '谜条总数', '猜中条数', '发放数量', '猜中谜号明细（复核）', '发奖谜号明细（复核）']);
    for (const r of list) {
      rows.push([r.key, r.total ?? '', r.solved, r.issued, nosText(r.solvedNos), nosText(r.issuedNos)]);
    }
    rows.push(['合计',
      list.reduce((s, r) => s + (r.total ?? 0), 0),
      list.reduce((s, r) => s + r.solved, 0),
      list.reduce((s, r) => s + r.issued, 0), '', '']);
    rows.push([]);
  };
  dimRows('三、按谜目汇总', '谜目', rep.byCategory);
  dimRows('四、按难度汇总', '难度', rep.byDifficulty);
  dimRows('五、按标签汇总（同一谜条可挂多个标签，合计可能大于总数）', '标签', rep.byTag);

  rows.push(['六、始终没人猜中的谜条']);
  rows.push(['谜号', '谜面', '谜目', '难度（星）', '标签']);
  for (const u of rep.unsolvedRiddles) {
    rows.push([u.no, u.surface, CATEGORY_LABEL[u.category], u.difficulty, u.tags.join('、')]);
  }
  rows.push([]);

  rows.push(['七、领了奖却没有登记猜中者的记录']);
  rows.push(['谜号', '奖项', '兑奖号码', '登记时间']);
  for (const n of rep.noWinnerRecords) {
    rows.push([n.no ?? '（谜条已不在谜库）', n.prize, n.code ?? '', formatDateTime(n.at)]);
  }
  rows.push([]);

  rows.push(['八、数目核对']);
  if (!rep.issues.length) {
    rows.push(['未发现对不上的地方']);
  } else {
    rows.push(['序号', '问题类型', '说明']);
    rep.issues.forEach((iss, i) => rows.push([i + 1, ISSUE_LABEL[iss.kind], iss.text]));
  }
  return withBOM(stringifyCSV(rows));
}
