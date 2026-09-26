// 结算报表：范围可选（整个活动 / 某一天），按奖项·谜目·难度·标签汇总，
// 未猜中谜条、领奖未登记猜中者、数目核对；可导出单个 CSV 文件、打印一页纸
import { useMemo, useState } from 'react';
import { useAppState } from '../ui/router';
import { CATEGORY_LABEL } from '../types';
import { formatDateTime, downloadText } from '../lib/format';
import {
  buildReport, recordDays, reportToCSV,
  ISSUE_LABEL, type AggRow, type SettlementReport,
} from '../lib/report';
import { exportFileName } from '../lib/store';
import { Stars } from '../ui/bits';

// 打印一页纸的截断上限（完整明细见导出文件）
const PRINT_TAG_ROWS = 12;
const PRINT_UNSOLVED = 40;
const PRINT_NO_WINNER = 10;
const PRINT_ISSUES = 10;

const nosText = (nos: number[]) => nos.join('、');

function AggTable({ title, rows, withTotal }: { title: string; rows: AggRow[]; withTotal: boolean }) {
  const sum = (f: (r: AggRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return (
    <div className="table-wrap report-table">
      <table>
        <thead>
          <tr>
            <th>{title}</th>
            {withTotal && <th className="num">谜条总数</th>}
            <th className="num">猜中条数</th>
            <th className="num">发放数量</th>
            <th>复核明细</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              {withTotal && <td className="num">{r.total}</td>}
              <td className="num">{r.solved}</td>
              <td className="num">{r.issued}</td>
              <td>
                {(r.solvedNos.length > 0 || r.issuedNos.length > 0) ? (
                  <details className="report-detail">
                    <summary>谜号明细</summary>
                    {r.solvedNos.length > 0 && <div>猜中：{nosText(r.solvedNos)}</div>}
                    {r.issuedNos.length > 0 && <div>发奖：{nosText(r.issuedNos)}</div>}
                  </details>
                ) : <span className="muted">—</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted">（无数据）</td></tr>}
        </tbody>
        <tfoot>
          <tr>
            <td>合计</td>
            {withTotal && <td className="num">{sum((r) => r.total ?? 0)}</td>}
            <td className="num">{sum((r) => r.solved)}</td>
            <td className="num">{sum((r) => r.issued)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** 打印用紧凑小表（无明细列） */
function PrintAggTable({ title, rows, withTotal }: { title: string; rows: AggRow[]; withTotal: boolean }) {
  return (
    <table className="rp-table">
      <thead>
        <tr>
          <th>{title}</th>
          {withTotal && <th>总数</th>}
          <th>猜中</th>
          <th>发放</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            {withTotal && <td>{r.total}</td>}
            <td>{r.solved}</td>
            <td>{r.issued}</td>
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={4}>（无）</td></tr>}
      </tbody>
    </table>
  );
}

function ReportSheet({ rep, title, host }: { rep: SettlementReport; title: string; host: string }) {
  const tags = rep.byTag.slice(0, PRINT_TAG_ROWS);
  const unsolved = rep.unsolvedRiddles.slice(0, PRINT_UNSOLVED);
  const noWinner = rep.noWinnerRecords.slice(0, PRINT_NO_WINNER);
  const issues = rep.issues.slice(0, PRINT_ISSUES);
  return (
    <section className="report-sheet" data-testid="report-sheet">
      <header className="rp-head">
        <h2>{title || '（未填写活动名称）'} · 活动结算报表</h2>
        <p>
          <span>主办方：{host || '（未填写）'}</span>
          <span>统计范围：{rep.scopeLabel}</span>
        </p>
      </header>

      <p className="rp-summary">
        谜条总数 <b>{rep.totalRiddles}</b> 条 ｜ 猜中 <b>{rep.solved}</b> 条 ｜ 未猜中 <b>{rep.unsolved}</b> 条 ｜
        奖品发放 <b>{rep.issued}</b> 份 ｜ 登记记录 <b>{rep.recordsInScope}</b> 条
        {rep.orphanRecords.length > 0 && <>（其中 {rep.orphanRecords.length} 条谜号对不上，见核对）</>}
      </p>

      <div className="rp-grid">
        <PrintAggTable title="按奖项" rows={rep.byPrize} withTotal={false} />
        <PrintAggTable title="按谜目" rows={rep.byCategory} withTotal />
        <PrintAggTable title="按难度" rows={rep.byDifficulty} withTotal />
        <div>
          <PrintAggTable title="按标签" rows={tags} withTotal />
          {rep.byTag.length > tags.length && (
            <p className="rp-note">标签共 {rep.byTag.length} 项，本页仅列前 {tags.length} 项，完整见导出文件。</p>
          )}
        </div>
      </div>

      <div className="rp-block">
        <h4>始终没人猜中的谜条（{rep.unsolvedRiddles.length}）</h4>
        {unsolved.length ? (
          <p className="rp-line">
            {unsolved.map((u) => `${u.no}号`).join('、')}
            {rep.unsolvedRiddles.length > unsolved.length && ` …… 共 ${rep.unsolvedRiddles.length} 条，完整清单见导出文件`}
          </p>
        ) : <p className="rp-line">无，全部谜条均被猜中。</p>}
      </div>

      <div className="rp-block">
        <h4>领了奖却没有登记猜中者的记录（{rep.noWinnerRecords.length}）</h4>
        {noWinner.length ? (
          <ul className="rp-list">
            {noWinner.map((n) => (
              <li key={n.id}>
                {n.no != null ? `谜号 ${n.no}` : '（谜条已不在谜库）'} · {n.prize}
                {n.code ? ` · ${n.code}` : ''} · {formatDateTime(n.at)}
              </li>
            ))}
            {rep.noWinnerRecords.length > noWinner.length && (
              <li>…… 共 {rep.noWinnerRecords.length} 条，完整清单见导出文件</li>
            )}
          </ul>
        ) : <p className="rp-line">无。</p>}
      </div>

      <div className="rp-block">
        <h4>数目核对（{rep.issues.length} 项需核对）</h4>
        {issues.length ? (
          <ul className="rp-list">
            {issues.map((iss, i) => <li key={i}>[{ISSUE_LABEL[iss.kind]}] {iss.text}</li>)}
            {rep.issues.length > issues.length && <li>…… 共 {rep.issues.length} 项，完整清单见导出文件</li>}
          </ul>
        ) : <p className="rp-line">未发现对不上的地方：发放数量、猜中条数与登记记录互相吻合。</p>}
      </div>

      <footer className="rp-foot">本页为汇总页，完整明细（含逐项谜号）请使用「导出报表文件」。</footer>
    </section>
  );
}

export function Report() {
  const state = useAppState();
  const { event, prizes } = state.settings;
  const [scopeKind, setScopeKind] = useState<'all' | 'day'>('all');
  const days = useMemo(() => recordDays(state.records), [state.records]);
  const [day, setDay] = useState<string>(() => days[days.length - 1] ?? event.date ?? '');

  const scope = useMemo(
    () => (scopeKind === 'all' ? { kind: 'all' as const } : { kind: 'day' as const, day }),
    [scopeKind, day],
  );
  // 纯函数重算：同一范围连续渲染结果一致；切换范围后各表数字随之更新
  const rep = useMemo(
    () => buildReport(state.riddles, state.records, scope, { prizeNames: prizes }),
    [state.riddles, state.records, scope, prizes],
  );

  const doExport = () => {
    const csv = reportToCSV(rep, { title: event.title, host: event.host });
    const scopePart = scope.kind === 'all' ? '整个活动' : scope.day;
    downloadText(exportFileName(`结算报表-${scopePart}`, 'csv'), csv);
  };

  return (
    <div>
      <div className="page-head no-print">
        <h1>结算报表 <small>{rep.scopeLabel} · 猜中 {rep.solved} / {rep.totalRiddles} 条 · 发奖 {rep.issued} 份</small></h1>
        <div className="btn-row">
          <button className="btn" onClick={doExport}>⬇ 导出报表文件（CSV）</button>
          <button className="btn btn-primary" onClick={() => window.print()}>🖨 打印一页纸</button>
        </div>
      </div>

      <div className="panel no-print">
        <div className="field-row">
          <label className="field">
            <span>统计范围</span>
            <select className="input" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as 'all' | 'day')}>
              <option value="all">整个活动（全部 {state.records.length} 条登记）</option>
              <option value="day">指定某一天</option>
            </select>
          </label>
          {scopeKind === 'day' && (
            <label className="field">
              <span>选择日期（按登记时间）</span>
              <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </label>
          )}
        </div>
        {scopeKind === 'day' && days.length > 0 && (
          <div className="btn-row wrap">
            <span className="muted small">有登记的日期：</span>
            {days.map((d) => (
              <button key={d} className={`btn btn-sm${d === day ? ' btn-primary' : ''}`} onClick={() => setDay(d)}>{d}</button>
            ))}
          </div>
        )}
        {scopeKind === 'day' && !day && <p className="warn-text">请先选择日期。</p>}
        <p className="muted small">切换范围后下方所有数字随之重算；每行「复核明细」列出构成该数字的谜号，可逐条对照。同一范围重复计算结果一致。</p>
      </div>

      <div className="stat-row no-print">
        <div className="stat"><b>{rep.totalRiddles}</b><span>谜条总数</span></div>
        <div className="stat stat-ok"><b>{rep.solved}</b><span>猜中条数</span></div>
        <div className="stat"><b>{rep.unsolved}</b><span>未猜中</span></div>
        <div className="stat"><b>{rep.issued}</b><span>奖品发放</span></div>
        <div className="stat"><b>{rep.recordsInScope}</b><span>登记记录{rep.orphanRecords.length > 0 ? `（${rep.orphanRecords.length} 条对不上）` : ''}</span></div>
      </div>

      <div className="panel no-print">
        <h3>数目核对</h3>
        {rep.issues.length === 0 ? (
          <p className="ok-text">✓ 未发现对不上的地方：发放数量、猜中条数与登记记录互相吻合。</p>
        ) : (
          <ul className="check-list check-suspect">
            {rep.issues.map((iss, i) => <li key={i}>[{ISSUE_LABEL[iss.kind]}] {iss.text}</li>)}
          </ul>
        )}
      </div>

      <div className="report-grid no-print">
        <div className="panel">
          <h3>按奖项汇总</h3>
          <AggTable title="奖项" rows={rep.byPrize} withTotal={false} />
          <p className="muted small">发放数量不去重：同一谜号重复发奖会重复计数（见「数目核对」）。</p>
        </div>
        <div className="panel">
          <h3>按谜目汇总</h3>
          <AggTable title="谜目" rows={rep.byCategory} withTotal />
        </div>
        <div className="panel">
          <h3>按难度汇总</h3>
          <AggTable title="难度" rows={rep.byDifficulty} withTotal />
        </div>
        <div className="panel">
          <h3>按标签汇总</h3>
          <AggTable title="标签" rows={rep.byTag} withTotal />
          <p className="muted small">同一谜条可挂多个标签，会同时计入多个标签行，合计大于谜条总数属正常。</p>
        </div>
      </div>

      <div className="panel no-print">
        <h3>始终没人猜中的谜条（{rep.unsolvedRiddles.length}）</h3>
        {rep.unsolvedRiddles.length === 0 ? (
          <p className="ok-text">✓ 范围内全部谜条均被猜中。</p>
        ) : (
          <div className="table-wrap report-table">
            <table>
              <thead><tr><th>谜号</th><th>谜面</th><th>谜目</th><th>难度</th><th>标签</th></tr></thead>
              <tbody>
                {rep.unsolvedRiddles.map((u) => (
                  <tr key={u.no}>
                    <td className="no-cell">{u.no}</td>
                    <td>{u.surface}</td>
                    <td>{CATEGORY_LABEL[u.category]}</td>
                    <td><Stars n={u.difficulty} /></td>
                    <td>{u.tags.map((t) => <span key={t} className="tag">{t}</span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel no-print">
        <h3>领了奖却没有登记猜中者的记录（{rep.noWinnerRecords.length}）</h3>
        {rep.noWinnerRecords.length === 0 ? (
          <p className="ok-text">✓ 范围内发奖记录均登记了猜中者。</p>
        ) : (
          <div className="table-wrap report-table">
            <table>
              <thead><tr><th>谜号</th><th>奖项</th><th>兑奖号码</th><th>登记时间</th></tr></thead>
              <tbody>
                {rep.noWinnerRecords.map((n) => (
                  <tr key={n.id}>
                    <td className="no-cell">{n.no ?? '（谜条已不在谜库）'}</td>
                    <td>{n.prize}</td>
                    <td>{n.code ?? ''}</td>
                    <td className="muted">{formatDateTime(n.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="print-area">
        <ReportSheet rep={rep} title={event.title} host={event.host} />
      </div>
    </div>
  );
}
