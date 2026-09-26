// 结算报表：选范围（整个活动/某一天）→ 总览 + 按奖项/谜目/难度/标签汇总 + 未猜中清单 + 异常核对
// 每个汇总数字都可点开明细复核；可导出 CSV，也可打印成一页纸交主办方
import { Fragment, useMemo, useState } from 'react';
import { useAppState } from '../ui/router';
import {
  buildReport, reportToCSV, sumRows,
  type ReportRecordRow, type ReportScope, type SummaryRow,
} from '../lib/report';
import { withBOM } from '../lib/csv';
import { downloadText, formatDateTime } from '../lib/format';
import { exportFileName } from '../lib/store';
import { CATEGORY_LABEL } from '../types';

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 复核明细：组成某个汇总数字的全部登记记录 */
function RecordDetail({ records }: { records: ReportRecordRow[] }) {
  if (!records.length) return <p className="muted small">该范围内没有登记记录。</p>;
  return (
    <table className="rpt-detail-table">
      <thead>
        <tr><th>谜号</th><th>谜面</th><th>猜中者</th><th>奖项</th><th>兑奖号</th><th>登记时间</th></tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <tr key={r.recordId}>
            <td className="no-cell">{r.no ?? '已删除'}</td>
            <td>{r.surface || '（谜条已删除）'}</td>
            <td>{r.winnerName || <span className="warn-text">未登记</span>}</td>
            <td>{r.prize || <span className="muted">未填</span>}</td>
            <td>{r.code}</td>
            <td className="muted">{formatDateTime(r.at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 四张汇总表共用：点击行展开/收起复核明细 */
function SummaryTable({ title, head, rows, note, expanded, onToggle }: {
  title: string;
  head: string;
  rows: SummaryRow[];
  note?: string;
  expanded: string | null;
  onToggle: (key: string) => void;
}) {
  const total = sumRows(rows);
  const hasRiddles = rows.length > 0 && rows[0].riddles !== null;
  return (
    <section className="rpt-sec rpt-summary">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted small">暂无数据。</p>
      ) : (
        <>
          <table>
            <thead>
              <tr><th>{head}</th><th>谜条数</th><th>猜中条数</th><th>发放数量</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.key}>
                  <tr
                    className={`rpt-sum-row${expanded === r.key ? ' rpt-sum-open' : ''}`}
                    onClick={() => onToggle(r.key)}
                    title="点击展开/收起明细复核"
                  >
                    <td>{r.label}<span className="rpt-caret no-print">{expanded === r.key ? '▾' : '▸'}</span></td>
                    <td>{r.riddles ?? '—'}</td>
                    <td>{r.solved}</td>
                    <td>{r.prizes}</td>
                  </tr>
                  {expanded === r.key && (
                    <tr className="rpt-detail">
                      <td colSpan={4}><RecordDetail records={r.records} /></td>
                    </tr>
                  )}
                </Fragment>
              ))}
              <tr className="rpt-total">
                <td>合计</td>
                <td>{hasRiddles ? total.riddles : '—'}</td>
                <td>{total.solved}</td>
                <td>{total.prizes}</td>
              </tr>
            </tbody>
          </table>
          {note && <p className="rpt-note">{note}</p>}
        </>
      )}
    </section>
  );
}

export function Report() {
  const state = useAppState();
  const { event, prizes } = state.settings;
  const [kind, setKind] = useState<'all' | 'day'>('all');
  const [day, setDay] = useState(event.date || todayStr());
  const [expanded, setExpanded] = useState<string | null>(null);

  const scope: ReportScope = kind === 'day' ? { kind: 'day', day: day || todayStr() } : { kind: 'all' };
  const report = useMemo(
    () => buildReport(state.riddles, state.records, scope, prizes),
    // scope 由 kind/day 派生，避免每次渲染新对象导致重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.riddles, state.records, kind, day, prizes],
  );
  const o = report.overview;

  const toggle = (key: string) => setExpanded((cur) => (cur === key ? null : key));

  const exportCSV = () => {
    const scopePart = scope.kind === 'all' ? '整个活动' : scope.day;
    downloadText(exportFileName(`结算报表-${scopePart}`, 'csv'), withBOM(reportToCSV(report, event)));
  };

  const orphanPrizes = report.anomalies.orphanRecords.filter((r) => r.prize.trim()).length;
  const catNote = orphanPrizes > 0
    ? `注：${report.anomalies.orphanRecords.length} 条登记指向已删除谜条（含 ${orphanPrizes} 份奖），未归入本表，见第八节。`
    : undefined;
  const prizeSumNote = report.anomalies.duplicateSolved.length
    ? '注：同一谜条被重复登记时，其各条登记按所填奖项分别计入对应行。'
    : undefined;

  return (
    <div>
      <div className="page-head no-print">
        <h1>结算报表 <small>{report.scopeLabel}</small></h1>
        <div className="btn-row">
          <button className="btn" onClick={exportCSV}>⬇ 导出报表 CSV</button>
          <button className="btn btn-primary" onClick={() => window.print()}>🖨 打印一页（交主办方）</button>
        </div>
      </div>

      <div className="panel no-print">
        <div className="field-row">
          <label className="field">
            <span>统计范围</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'all' | 'day')}>
              <option value="all">整个活动</option>
              <option value="day">指定某一天</option>
            </select>
          </label>
          {kind === 'day' && (
            <label className="field">
              <span>统计日期</span>
              <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </label>
          )}
        </div>
        <p className="muted small">
          切换范围后报表立即重算；点击汇总表任意一行可展开该数字对应的登记明细，逐项复核。
        </p>
      </div>

      <div className="report-print" data-testid="report-print">
        <header className="report-doc-head">
          <h2>{event.title || '灯谜活动'} · 结算报表</h2>
          <p>主办方：{event.host || '（未填写）'}　　统计范围：{report.scopeLabel}</p>
        </header>

        <section className="rpt-sec">
          <h3>一、总览</h3>
          <table className="rpt-overview">
            <thead>
              <tr><th>谜条总数</th><th>猜中条数</th><th>剩余未猜中</th><th>登记条数</th><th>奖品发放数</th></tr>
            </thead>
            <tbody>
              <tr>
                <td data-testid="ov-total">{o.totalRiddles}</td>
                <td data-testid="ov-solved">{o.solvedRiddles}</td>
                <td data-testid="ov-unsolved">{o.unsolvedRiddles}</td>
                <td data-testid="ov-records">{o.recordCount}</td>
                <td data-testid="ov-prizes">{o.prizeCount}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div className="rpt-grid">
          <SummaryTable title="二、按奖项汇总" head="奖项" rows={report.byPrize} note={prizeSumNote} expanded={expanded} onToggle={toggle} />
          <SummaryTable title="三、按谜目汇总" head="谜目" rows={report.byCategory} note={catNote} expanded={expanded} onToggle={toggle} />
          <SummaryTable title="四、按难度汇总" head="难度" rows={report.byDifficulty} note={catNote} expanded={expanded} onToggle={toggle} />
          <SummaryTable
            title="五、按标签汇总" head="标签" rows={report.byTag}
            note="注：一条谜可属多个标签，会在每个标签行各计一次，各行不必加总。"
            expanded={expanded} onToggle={toggle}
          />
        </div>

        <section className="rpt-sec">
          <h3>六、{scope.kind === 'all' ? '始终没人猜中的谜条' : '当天没人猜中的谜条'}（{report.unsolved.length} 条）</h3>
          {report.unsolved.length === 0 ? (
            <p className="ok-text small">范围内全部谜条都被猜中了。</p>
          ) : (
            <>
              <div className="table-wrap rpt-unsolved-wrap no-print">
                <table>
                  <thead><tr><th>谜号</th><th>谜面</th><th>谜目</th><th>难度</th><th>标签</th></tr></thead>
                  <tbody>
                    {report.unsolved.map((u) => (
                      <tr key={u.id}>
                        <td className="no-cell">{u.no}</td>
                        <td>{u.surface}</td>
                        <td>{CATEGORY_LABEL[u.category]}</td>
                        <td>{u.difficulty} 星</td>
                        <td className="muted">{u.tags.join('、')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* 打印版：三栏紧凑排列，保证一页纸 */}
              <ul className="rpt-unsolved-print">
                {report.unsolved.map((u) => (
                  <li key={u.id}><b>{u.no}</b>　{u.surface}（{CATEGORY_LABEL[u.category]}·{u.difficulty}星）</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="rpt-sec">
          <h3>七、领了奖却没有登记猜中者的记录（{report.prizeNoWinner.length} 条）</h3>
          {report.prizeNoWinner.length === 0 ? (
            <p className="ok-text small">没有此类记录。</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>谜号</th><th>谜面</th><th>奖项</th><th>兑奖号</th><th>登记时间</th><th>备注</th></tr></thead>
                <tbody>
                  {report.prizeNoWinner.map((r) => (
                    <tr key={r.recordId}>
                      <td className="no-cell">{r.no ?? '已删除'}</td>
                      <td>{r.surface || '（谜条已删除）'}</td>
                      <td>{r.prize}</td>
                      <td>{r.code}</td>
                      <td className="muted">{formatDateTime(r.at)}</td>
                      <td className="muted">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rpt-sec">
          <h3>八、数目核对</h3>
          <ul className="rpt-notes">
            {report.anomalies.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
          {(report.anomalies.orphanRecords.length > 0 || report.anomalies.duplicateSolved.length > 0) && (
            <div className="rpt-anomaly-grid">
              {report.anomalies.orphanRecords.length > 0 && (
                <div>
                  <h4>指向已删除谜条的登记（{report.anomalies.orphanRecords.length}）</h4>
                  <RecordDetail records={report.anomalies.orphanRecords} />
                </div>
              )}
              {report.anomalies.duplicateSolved.length > 0 && (
                <div>
                  <h4>被重复登记的谜条（{report.anomalies.duplicateSolved.length}）</h4>
                  <table className="rpt-detail-table">
                    <thead><tr><th>谜号</th><th>谜面</th><th>登记次数</th><th>多发奖品</th></tr></thead>
                    <tbody>
                      {report.anomalies.duplicateSolved.map((g) => (
                        <tr key={g.riddleId}>
                          <td className="no-cell">{g.no}</td>
                          <td>{g.surface}</td>
                          <td>{g.count}</td>
                          <td>{g.extraPrizes > 0 ? `${g.extraPrizes} 份` : '无'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
