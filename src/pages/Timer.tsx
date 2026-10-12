import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PomodoroSettings, Project, TimerCommand, TimerResult, TimerSnapshot } from '../../shared/contracts';
import { durations, formatDuration, remainingTime } from '../../shared/timing';
import { api, errorMessage, operationId, RequestError } from '../api';
import { defaultPomodoro, validPomodoro } from '../../shared/pomodoro';
import { loadPomodoro, savePomodoro } from '../pomodoroSettings';
import styles from './Timer.module.css';

const notificationKey = 'my-working-logger.timer-updated';
const pendingKey = 'my-working-logger.pending-timer-command';
function readPending(): TimerCommand | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
    if (value && typeof value.operation_id === 'string' && Number.isInteger(value.revision)
      && ['start', 'pause', 'resume', 'finish', 'start_break', 'start_focus', 'skip'].includes(value.action)) return value;
  } catch { /* Storage 無効時も、その画面内では再送可能。 */ }
  return null;
}
export default function Timer() {
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'normal' | 'pomodoro'>('normal');
  const [settings, setSettings] = useState<PomodoroSettings>({ ...defaultPomodoro });
  const [storageError, setStorageError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<TimerCommand | null>(readPending);
  const [tick, setTick] = useState(0);
  const anchor = useRef({ now: 0, monotonic: 0 });
  const version = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const apply = useCallback((value: TimerSnapshot) => {
    anchor.current = { now: value.server_now, monotonic: performance.now() };
    setSnapshot(value);
  }, []);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const requestVersion = ++version.current;
    try {
      const [value, list] = await Promise.all([api<TimerSnapshot>('/timer'), api<{ projects: Project[] }>('/projects')]);
      if (!mounted.current || requestVersion !== version.current) return;
      apply(value); setProjects(list.projects); setError('');
    } catch (e) {
      if (mounted.current && requestVersion === version.current) setError(errorMessage(e));
    }
  }, [apply]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    const tickTimer = window.setInterval(() => { if (!document.hidden) setTick((t) => t + 1); }, 250);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    const onStorage = (event: StorageEvent) => { if (event.key === notificationKey && !document.hidden) void refresh(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onVisible);
    window.addEventListener('pageshow', onVisible);
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false; ++version.current;
      clearInterval(timer); clearInterval(tickTimer);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onVisible); window.removeEventListener('pageshow', onVisible);
      window.removeEventListener('online', onVisible); document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);
  useEffect(() => { if (!projects.some((p) => p.id === selected)) setSelected(projects[0]?.id ?? ''); }, [projects, selected]);
  useEffect(() => { setSettings(loadPomodoro(selected)); setStorageError(''); }, [selected]);
  function editSettings(key: keyof PomodoroSettings, value: number) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    if (validPomodoro(next)) setStorageError(savePomodoro(selected, next) ? '' : 'このブラウザでは設定を保存できません。現在の画面内では利用できます。');
  }
  function remember(command: TimerCommand | null) {
    setPending(command);
    try { if (command) sessionStorage.setItem(pendingKey, JSON.stringify(command)); else sessionStorage.removeItem(pendingKey); } catch { /* memory 上で保持 */ }
  }
  async function send(command: TimerCommand) {
    if (inFlight.current) return;
    inFlight.current = true; ++version.current; setBusy(true); setError(''); setMessage(''); remember(command);
    try {
      const result = await api<TimerResult>('/timer', { method: 'POST', body: JSON.stringify(command) });
      if (!mounted.current) return;
      apply(result); remember(null);
      try { localStorage.setItem(notificationKey, command.operation_id); } catch { /* 他タブは定期読取で同期 */ }
      if (result.outcome.action === 'finish') setMessage(result.outcome.discarded ? '実作業時間が0秒のため、実績は保存しませんでした。' : result.outcome.session_id ? '作業実績を保存しました。' : 'ポモドーロを終了しました。');
    } catch (e) {
      if (!mounted.current) return;
      // 競合・入力拒否は未実行。通信失敗/5xx は同じ ID で結果を確認・再送する。
      if (e instanceof RequestError && [400, 403, 404, 409].includes(e.status)) remember(null);
      setError(errorMessage(e));
    } finally {
      inFlight.current = false;
      if (mounted.current) { setBusy(false); void refresh(); }
    }
  }
  function act(action: TimerCommand['action']) {
    if (!snapshot || busy || pending) return;
    const timer = snapshot.timer;
    if (action === 'finish' && !window.confirm(timer.mode === 'pomodoro' ? 'ポモドーロを終了しますか？集中中の実作業は保存します。' : 'この作業を終了して実績を保存しますか？')) return;
    const base = { operation_id: operationId(), revision: timer.revision };
    if (action === 'start') {
      if (!selected) return;
      if (mode === 'pomodoro') {
        if (!validPomodoro(settings)) return;
        savePomodoro(selected, settings);
        void send({ ...base, action, project_id: selected, mode, pomodoro: settings });
      } else void send({ ...base, action, project_id: selected });
    }
    else if (timer.timer_id) void send({ ...base, action, timer_id: timer.timer_id });
  }
  const timer = snapshot?.timer;
  const now = anchor.current.now + Math.max(0, performance.now() - anchor.current.monotonic);
  const time = timer ? durations(timer, now) : { active: 0, paused: 0, elapsed: 0 };
  const remaining = timer ? remainingTime(timer, now) : null;
  const effectiveMode = !timer || timer.status === 'idle' ? mode : timer.mode;
  const activeSettings = timer?.mode === 'pomodoro' ? timer.pomodoro! : settings;
  const phaseName = timer?.phase === 'short_break' ? '短い休憩' : timer?.phase === 'long_break' ? '長い休憩' : '集中';
  const expirationCheck = useRef<string | null>(null);
  useEffect(() => {
    if (timer?.mode === 'pomodoro' && timer.status === 'running' && remaining === 0 && !busy) {
      const key = `${timer.timer_id}:${timer.revision}`;
      if (expirationCheck.current !== key) { expirationCheck.current = key; void refresh(); }
    } else if (remaining !== 0) expirationCheck.current = null;
  }, [timer, remaining, busy, refresh, tick]);
  const primaryTime = effectiveMode === 'pomodoro' ? remaining ?? settings.focus_minutes * 60000 : time.active;
  const controlsDisabled = busy || !!pending;
  void tick;
  return <section aria-labelledby="timer-heading">
    <h1 id="timer-heading">タイマー</h1><p>今日の作業を記録します。</p>
    {!timer ? <p role="status">読み込み中…</p> : <>
      {timer.status === 'idle' ? <label className={styles.select}>作業<select value={selected} disabled={busy || !!pending || !projects.length} onChange={(e) => setSelected(e.target.value)}>
        {!projects.length && <option value="">作業がありません</option>}
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label> : <p className={styles.project} style={{ borderLeftColor: timer.color ?? '#175c50' }}>{timer.project_name}<br /><small>作業の変更はタイマー終了後にできます。</small></p>}
      {timer.status === 'idle' && <label className={styles.select}>タイマー方式<select value={mode} disabled={controlsDisabled} onChange={(e) => setMode(e.target.value as 'normal' | 'pomodoro')}>
        <option value="normal">通常タイマー</option><option value="pomodoro">ポモドーロ</option>
      </select></label>}
      <div className={styles.panel}>
        <p className={styles.status}>{timer.status === 'waiting' ? `${phaseName}の開始待ち` : timer.status === 'paused' ? '一時停止中' : timer.status === 'running' ? (effectiveMode === 'pomodoro' ? `${phaseName}中` : '計測中') : '未開始'}</p>
        <p>{effectiveMode === 'pomodoro' ? `${phaseName}の残り時間` : '実作業時間'}</p><p className={styles.time}>{formatDuration(effectiveMode === 'pomodoro' ? Math.ceil((Number.isFinite(primaryTime) ? primaryTime : 0) / 1000) * 1000 : primaryTime)}</p>
        {timer.mode === 'pomodoro' && <p>集中完了 {timer.completed_focus} 回 · {activeSettings.long_break_every} 回ごとに長い休憩</p>}
        <dl className={styles.details}><div><dt>経過時間</dt><dd>{formatDuration(time.elapsed)}</dd></div><div><dt>一時停止合計</dt><dd>{formatDuration(time.paused)}</dd></div></dl>
        <div className={styles.actions}>
          {timer.status === 'idle' ? <button disabled={controlsDisabled || !selected || (mode === 'pomodoro' && !validPomodoro(settings))} onClick={() => act('start')}>開始</button> : <>
            {timer.status === 'waiting'
              ? <button disabled={controlsDisabled} onClick={() => act(timer.phase === 'focus' ? 'start_focus' : 'start_break')}>{timer.phase === 'focus' ? '次の集中を開始' : `${phaseName}を開始`}</button>
              : <button disabled={controlsDisabled} onClick={() => act(timer.status === 'running' ? 'pause' : 'resume')}>{timer.status === 'running' ? '一時停止' : '再開'}</button>}
            {timer.mode === 'pomodoro' && timer.phase !== 'focus' && <button disabled={controlsDisabled} onClick={() => act('skip')}>休憩をスキップ</button>}
            <button disabled={controlsDisabled} onClick={() => act('finish')}>{timer.mode === 'pomodoro' ? 'ポモドーロを終了' : '終了して保存'}</button>
          </>}
        </div>
      </div>
      {effectiveMode === 'pomodoro' && <details className={styles.settings} open={timer.status === 'idle'}>
        <summary>ポモドーロ設定{timer.status !== 'idle' && '（開始時の設定）'}</summary>
        <fieldset disabled={controlsDisabled || timer.status !== 'idle' || !selected}>
          <legend>作業別の設定</legend>
          {([['focus_minutes', '集中（分）'], ['short_break_minutes', '短い休憩（分）'], ['long_break_minutes', '長い休憩（分）'], ['long_break_every', '長い休憩までの集中回数']] as const).map(([key, label]) =>
            <label key={key}>{label}<input type="number" inputMode="numeric" min={1} max={key === 'long_break_every' ? 20 : 180} step={1}
              value={Number.isFinite(activeSettings[key]) ? activeSettings[key] : ''} onChange={(e) => editSettings(key, e.target.valueAsNumber)} /></label>)}
        </fieldset>
        <p>{timer.status === 'idle' ? '作業ごとに、このブラウザに自動保存します。時間は1〜180分、回数は1〜20回で指定してください。' : 'このポモドーロを終了するまで、開始時の設定を使用します。'}</p>
        {timer.status === 'idle' && !validPomodoro(settings) && <p role="alert">時間と回数を指定範囲の整数で入力してください。</p>}
        {storageError && <p role="alert">{storageError}</p>}
      </details>}
      {!projects.length && timer.status === 'idle' && <p><Link to="/projects">作業管理</Link>で作業を追加してください。</p>}
      <p className={styles.note}>ブラウザを閉じても計測は続きます。一時停止中はその状態で復元します。集中満了時は実績を保存し、休憩と次の集中は手動で開始します。</p>
    </>}
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => void refresh()}>状態を再読み込み</button></p>}
    {message && <p role="status">{message}</p>}
    {pending && !busy && <div role="status"><p>前の操作の結果を確認してください。同じ操作 ID で安全に再送できます。</p>
      <button disabled={busy} onClick={() => void send(pending)}>送信結果を確認・再送</button></div>}
  </section>;
}
