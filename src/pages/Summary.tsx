import { useEffect, useRef, useState } from 'react';
import type { WorkSession } from '../../shared/contracts';
const formatDuration = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
import { dateStart, DAY_MS, editTime, parseTime, sessionDate, shiftDate, validSession } from '../../shared/sessionTime';
import { api, errorMessage } from '../api';
import styles from './Summary.module.css';
const clock = (time: number) => new Date(time).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const range = (s: WorkSession) => `${sessionDate(s.started_at) !== sessionDate(s.ended_at) ? `${sessionDate(s.started_at)} ` : ''}${clock(s.started_at)} 〜 ${sessionDate(s.started_at) !== sessionDate(s.ended_at) ? `${sessionDate(s.ended_at)} ` : ''}${clock(s.ended_at)}`;

function Editor({ session, close, saved }: { session: WorkSession; close: () => void; saved: (date: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [start, setStart] = useState(editTime(session.started_at).slice(0, 16));
  const [end, setEnd] = useState(editTime(session.ended_at).slice(0, 16));
  const [pause, setPause] = useState(formatDuration(session.paused_ms));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [overlaps, setOverlaps] = useState<WorkSession[] | null>(null);
  const [overlapError, setOverlapError] = useState('');
  // 表示上の秒切り捨てだけで、既存の記録を変更しない。
  const started_at = start === editTime(session.started_at).slice(0, 16) ? session.started_at : parseTime(start);
  const ended_at = end === editTime(session.ended_at).slice(0, 16) ? session.ended_at : parseTime(end);
  const paused_ms = pause === formatDuration(session.paused_ms) ? session.paused_ms
    : /^\d{2,}:[0-5]\d$/.test(pause) ? (Number(pause.split(':')[0]) * 60 + Number(pause.split(':')[1])) * 60000 : NaN;
  const valid = pause.trim() !== '' && validSession(started_at, ended_at, paused_ms);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true; setOverlaps(null); setOverlapError('');
    if (valid) void api<{ sessions: WorkSession[] }>(`/sessions?overlap_start=${started_at}&overlap_end=${ended_at}`)
      .then((data) => { if (active) setOverlaps(data.sessions.filter((s) => s.id !== session.id)); })
      .catch((e) => { if (active) setOverlapError(errorMessage(e)); });
    return () => { active = false; };
  }, [started_at, ended_at, valid, session.id]);
  async function mutate(remove = false) {
    if (remove && !window.confirm('この実績を削除しますか？')) return;
    setBusy(true); setError('');
    try {
      await api(`/sessions/${session.id}`, remove ? { method: 'DELETE' } : { method: 'PATCH', body: JSON.stringify({ started_at, ended_at, paused_ms }) });
      saved(remove ? sessionDate(session.started_at) : sessionDate(started_at));
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="edit-title" onCancel={(e) => { if (busy) e.preventDefault(); else close(); }}>
    <form onSubmit={(e) => { e.preventDefault(); if (valid && overlaps) void mutate(); }}>
      <div className={styles.toolbar}><h2 id="edit-title">実績を編集</h2><button type="button" disabled={busy} onClick={close} aria-label="閉じる">×</button></div>
      <p><strong>{session.project_name}</strong></p>
      <label>開始（日本時間）<input autoFocus type="datetime-local" step="60" required value={start} disabled={busy} onChange={(e) => setStart(e.target.value)} /></label>
      <label>終了（日本時間）<input type="datetime-local" step="60" required value={end} disabled={busy} onChange={(e) => setEnd(e.target.value)} /></label>
      <label>休憩合計（HH:MM）<input type="text" pattern="[0-9]{2,}:[0-5][0-9]" placeholder="00:00" required value={pause} disabled={busy} onChange={(e) => setPause(e.target.value)} /></label>
      <p>実作業時間（自動計算） <strong>{valid ? formatDuration(ended_at - started_at - paused_ms) : '—'}</strong></p>
      {!valid && <p role="alert">終了は開始より後、休憩はHH:MM形式で、実作業時間が残るように入力してください。</p>}
      {valid && overlaps === null && !overlapError && <p role="status">時間の重なりを確認中…</p>}
      {overlapError && <p role="alert">{overlapError} 時刻を変更するか、開き直して再試行してください。</p>}
      {!!overlaps?.length && <div role="status" className={styles.warning}><strong>時間の重なりがあります</strong><ul>{overlaps.map((s) => <li key={s.id}>{s.project_name}：{sessionDate(s.started_at)} {range(s)}</li>)}</ul>このまま保存することもできます。</div>}
      {error && <p role="alert">{error}</p>}
      <div className={styles.actions}><button disabled={busy || !valid || overlaps === null}>保存</button><button type="button" className={styles.danger} disabled={busy} onClick={() => void mutate(true)}>削除</button></div>
    </form>
  </dialog>;
}

export default function Summary() {
  const [date, setDate] = useState(() => sessionDate(Date.now()));
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<WorkSession | null>(null);
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setSessions([]);
    void api<{ sessions: WorkSession[] }>(`/sessions?date=${date}`).then((data) => { if (active) setSessions(data.sessions); })
      .catch((e) => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [date, revision]);
  const start = dateStart(date);
  const counted = sessions.filter((s) => sessionDate(s.started_at) === date);
  const sorted = [...sessions].sort((a, b) => a.started_at - b.started_at);
  const lanes: number[] = [];
  const blocks = sorted.map((s) => {
    let lane = lanes.findIndex((end) => end <= s.started_at);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = Math.min(s.ended_at, start + DAY_MS);
    return { s, lane };
  });
  return <section><h1>実績・サマリ</h1>
    <div className={styles.toolbar}>
      <button aria-label="前の日" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
      <label>日付（日本時間）<input type="date" required value={date} onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setDate(e.target.value); }} /></label>
      <button aria-label="次の日" onClick={() => setDate(shiftDate(date, 1))}>›</button>
      <button onClick={() => setDate(sessionDate(Date.now()))}>今日</button>
    </div>
    <div className={styles.totals}><strong>実作業 {formatDuration(counted.reduce((v, s) => v + s.active_seconds * 1000, 0))}</strong><span>作業セッション {counted.length}回</span></div>
    {error && <p role="alert">{error}</p>}{loading && <p role="status">読み込み中…</p>}
    {!loading && !error && !sessions.length && <p>この日の実績はありません。</p>}
    <div className={styles.scroll} tabIndex={0} aria-label="日別タイムライン（0:00〜24:00）">
      <div className={styles.timeline}>
        {Array.from({ length: 25 }, (_, hour) => <div key={hour} className={styles.hour} style={{ top: `${hour / 24 * 100}%` }}><span>{String(hour).padStart(2, '0')}:00</span></div>)}
        <div className={styles.track}>{blocks.map(({ s, lane }) => <button key={s.id} className={styles.block}
          aria-label={`${s.project_name} ${range(s)} 実作業 ${formatDuration(s.active_seconds * 1000)}${s.paused_ms > 0 ? ` 休憩合計 ${formatDuration(s.paused_ms)}` : ''}`}
          style={{ top: `${(Math.max(s.started_at, start) - start) / DAY_MS * 100}%`, height: `${(Math.min(s.ended_at, start + DAY_MS) - Math.max(s.started_at, start)) / DAY_MS * 100}%`, left: `${lane / lanes.length * 100}%`, width: `${100 / lanes.length}%`, borderColor: s.color, backgroundColor: `${s.color}25` }} onClick={() => setSelected(s)}>
          <span className={styles.blockText}><strong>{s.project_name}</strong><span>{range(s)}</span><span>実作業 {formatDuration(s.active_seconds * 1000)}</span></span>
          {s.paused_ms > 0 && <span className={styles.pause}>休憩: {formatDuration(s.paused_ms)}</span>}
        </button>)}</div>
      </div>
    </div>
    {!!sessions.length && <ul className={styles.list} aria-label="実績一覧">{sorted.map((s) => <li key={s.id}><button onClick={() => setSelected(s)}>{s.project_name}：{range(s)} ／ 実作業 {formatDuration(s.active_seconds * 1000)} ／ 休憩合計 {formatDuration(s.paused_ms)}</button></li>)}</ul>}
    {selected && <Editor session={selected} close={() => setSelected(null)} saved={(next) => { setSelected(null); setDate(next); setRevision((v) => v + 1); }} />}
  </section>;
}
