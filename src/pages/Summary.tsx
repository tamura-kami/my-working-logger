import { useCallback, useEffect, useState } from 'react';
import type { WorkSession } from '../../shared/contracts';
import { formatDuration } from '../../shared/timing';
import { api, errorMessage } from '../api';
import styles from './Summary.module.css';
const dateTime = (timestamp: number) => new Date(timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
export default function Summary() {
  const [sessions, setSessions] = useState<WorkSession[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setSessions((await api<{ sessions: WorkSession[] }>('/sessions')).sessions); }
    catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <section><h1>実績・サマリ</h1>
    <p>最近の作業実績（最大100件）を表示します。日時は日本時間です。</p>
    <button disabled={loading} onClick={() => void load()}>実績を再読み込み</button>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">読み込み中…</p>}
    {!loading && !error && !sessions.length && <p>まだ実績がありません。タイマーを終了すると保存されます。</p>}
    <ul className={styles.list}>{sessions.map((s) => <li key={s.id} className={styles.session} style={{ borderLeftColor: s.color }}>
      <h2>{s.project_name}</h2><p><time dateTime={new Date(s.started_at).toISOString()}>{dateTime(s.started_at)}</time> 〜 <time dateTime={new Date(s.ended_at).toISOString()}>{dateTime(s.ended_at)}</time></p>
      <p>実作業時間 <strong>{formatDuration(s.active_seconds * 1000)}</strong></p>
    </li>)}</ul>
    <p>日別タイムライン、実績編集、週・月の集計は今後の実装で追加します。</p>
  </section>;
}
