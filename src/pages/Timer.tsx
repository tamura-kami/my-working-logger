import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PomodoroSettings, Project, TimerCommand, TimerResult, TimerSnapshot } from '../../shared/contracts';
import { cycleDurations, formatDuration, remainingTime } from '../../shared/timing';
import { api, errorMessage, operationId, RequestError } from '../api';
import { defaultPomodoro, validPomodoro } from '../../shared/pomodoro';
import { loadPomodoro, savePomodoro, loadTimerMode, saveTimerMode } from '../pomodoroSettings';
import { TimerSound } from '../timerSound';
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
  const selectedRef = useRef('');
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
  const sound = useRef(new TimerSound());
  const [soundNotice, setSoundNotice] = useState('開始・再開時に終了音を有効にします。再読込後は「終了音を確認」を押してください。');
  const previousTimer = useRef<TimerSnapshot['timer'] | null>(null);
  const sounded = useRef<string | null>(null);
  const ring = useCallback((id: string | null) => {
    if (!id || sounded.current === id) return;
    sounded.current = id;
    if (!sound.current.play()) setSoundNotice('終了音を再生できません。「終了音を確認」を押して有効にしてください。');
  }, []);
  async function enableSound(test = false) {
    const enabled = await sound.current.enable();
    if (test && enabled) sound.current.play();
    setSoundNotice(enabled ? '終了音は有効です。集中・休憩の満了時に鳴ります。' : '終了音を有効にできません。ブラウザと端末の音量設定を確認してください。');
  }
  const apply = useCallback((value: TimerSnapshot, notify = true) => {
    const previous = previousTimer.current;
    // フェーズごとに満了音を一度だけ鳴らす。
    if (notify && previous?.mode === 'pomodoro' && previous.status === 'running'
      && value.timer.mode === 'pomodoro' && value.timer.phase !== previous.phase
      && previous.deadline_at !== null && value.timer.changed_at! >= previous.deadline_at) ring(`${previous.timer_id}:${previous.deadline_at}`);
    previousTimer.current = value.timer;
    anchor.current = { now: value.server_now, monotonic: performance.now() };
    setSnapshot(value);
  }, [ring]);
  const chooseProject = useCallback((id: string) => {
    selectedRef.current = id;
    setSelected(id);
    setSettings(loadPomodoro(id));
    setMode(loadTimerMode(id));
    setStorageError('');
  }, []);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const requestVersion = ++version.current;
    try {
      const [value, list] = await Promise.all([api<TimerSnapshot>('/timer'), api<{ projects: Project[] }>('/projects')]);
      if (!mounted.current || requestVersion !== version.current) return;
      if (!list.projects.some((p) => p.id === selectedRef.current)) chooseProject(list.projects[0]?.id ?? '');
      apply(value); setProjects(list.projects); setError('');
    } catch (e) {
      if (mounted.current && requestVersion === version.current) setError(errorMessage(e));
    }
  }, [apply, chooseProject]);
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
      mounted.current = false; ++version.current; sound.current.close();
      clearInterval(timer); clearInterval(tickTimer);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onVisible); window.removeEventListener('pageshow', onVisible);
      window.removeEventListener('online', onVisible); document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);
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
      apply(result, false); remember(null);
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
    if (action === 'finish' && !window.confirm(timer.mode === 'pomodoro' ? 'ポモドーロを終了しますか？ここまでの集中時間をまとめて保存します。' : 'この作業を終了して実績を保存しますか？')) return;
    if (['start', 'resume', 'start_break', 'start_focus'].includes(action)) void enableSound();
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
  const time = timer ? cycleDurations(timer, now) : { active: 0, paused: 0, elapsed: 0 };
  const remaining = timer ? remainingTime(timer, now) : null;
  const effectiveMode = !timer || timer.status === 'idle' ? mode : timer.mode;
  const activeSettings = timer?.mode === 'pomodoro' ? timer.pomodoro! : settings;
  const phaseName = timer?.phase === 'short_break' ? '短い休憩' : timer?.phase === 'long_break' ? '長い休憩' : '集中';
  const expirationCheck = useRef<string | null>(null);
  useEffect(() => {
    if (timer?.mode === 'pomodoro' && timer.status === 'running' && remaining === 0 && !busy) {
      const key = `${timer.timer_id}:${timer.revision}`;
      if (expirationCheck.current !== key) { expirationCheck.current = key; ring(`${timer.timer_id}:${timer.deadline_at}`); void refresh(); }
    } else if (remaining !== 0) expirationCheck.current = null;
  }, [timer, remaining, busy, refresh, tick, ring]);
  const primaryTime = effectiveMode === 'pomodoro' ? remaining ?? settings.focus_minutes * 60000 : time.active;
  const controlsDisabled = busy || !!pending;
  void tick;
  return <section aria-labelledby="timer-heading">
    <h1 id="timer-heading">タイマー</h1><p>今日の作業を記録します。</p>
    {!timer ? <p role="status">読み込み中…</p> : <>
      {timer.status === 'idle' ? <label className={styles.select}>作業<select value={selected} disabled={busy || !!pending || !projects.length} onChange={(e) => chooseProject(e.target.value)}>
        {!projects.length && <option value="">作業がありません</option>}
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label> : <p className={styles.project} style={{ borderLeftColor: timer.color ?? '#175c50' }}>{timer.project_name}<br /><small>作業の変更はタイマー終了後にできます。</small></p>}
      {timer.status === 'idle' && <fieldset className={styles.modePicker} disabled={controlsDisabled || !selected}>
        <legend>タイマー方式</legend>
        <div className={styles.modeOptions}>
          {(['normal', 'pomodoro'] as const).map((choice) => <button key={choice} type="button"
            className={styles.modeButton} aria-pressed={mode === choice}
            onClick={() => { setMode(choice); setStorageError(saveTimerMode(selected, choice) ? '' : 'このブラウザでは設定を保存できません。現在の画面内では利用できます。'); }}>
            {choice === 'normal' ? <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
              <circle cx="24" cy="24" r="19" fill="#f5faf8" stroke="currentColor" strokeWidth="2.5" />
              <path d="M24 10v3M38 24h-3M24 38v-3M10 24h3M24 16v9l7 4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="24" cy="24" r="2" fill="currentColor" />
            </svg> : <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
              <path d="M24 15C14 9 5 18 6 29c1 10 10 15 18 14 8 1 17-4 18-14 1-11-8-20-18-14Z" fill="#e75b4c" stroke="#b63f35" strokeWidth="2" />
              <path d="M24 17c-1-5 0-9 3-12" fill="none" stroke="#39754b" strokeWidth="3" strokeLinecap="round" />
              <path d="m24 15-10-3 5 7-7 2 10 1 2 6 3-6 9-1-7-3 5-7Z" fill="#4b8d51" stroke="#39754b" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M12 28c0 4 2 7 5 9" fill="none" stroke="#ffb0a1" strokeWidth="2.5" strokeLinecap="round" />
            </svg>}
            <span>{choice === 'normal' ? '通常タイマー' : 'ポモドーロ'}</span>
          </button>)}
        </div>
      </fieldset>}
      <div className={styles.panel}>
        <p className={styles.status}>{timer.status === 'waiting' ? `${phaseName}の開始待ち` : timer.status === 'paused' ? '一時停止中' : timer.status === 'running' ? (effectiveMode === 'pomodoro' ? `${phaseName}中` : '計測中') : '未開始'}</p>
        <p>{effectiveMode === 'pomodoro' ? `${phaseName}の残り時間` : '実作業時間'}</p><p className={styles.time}>{formatDuration(effectiveMode === 'pomodoro' ? Math.ceil((Number.isFinite(primaryTime) ? primaryTime : 0) / 1000) * 1000 : primaryTime)}</p>
        {timer.mode === 'pomodoro' && <p>集中完了 {timer.completed_focus} 回 · {activeSettings.long_break_every} 回ごとに長い休憩</p>}
        <dl className={styles.details}><div><dt>経過時間</dt><dd>{formatDuration(time.elapsed)}</dd></div><div><dt>{effectiveMode === 'pomodoro' ? '休止時間合計' : '一時停止合計'}</dt><dd>{formatDuration(time.paused)}</dd></div></dl>
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
      </details>}
      {!projects.length && timer.status === 'idle' && <p><Link to="/projects">作業管理</Link>で作業を追加してください。</p>}
      <p className={styles.note}>{effectiveMode === 'pomodoro' ? '画面を開いている間、集中と休憩が自動で切り替わります。長い休憩の直前に集中時間をまとめて保存し、短い休憩と一時停止は休止時間に含めます。画面を閉じている間の自動進行は保証しません。' : 'ブラウザを閉じても計測は続きます。一時停止中はその状態で復元します。'}</p>
    </>}
    <p><button onClick={() => void enableSound(true)}>終了音を確認</button> {soundNotice}</p>
    <p className={styles.note}>画面を閉じた状態や端末のスリープ中は終了音を鳴らせません。</p>
    {storageError && <p role="alert">{storageError}</p>}
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => void refresh()}>状態を再読み込み</button></p>}
    {message && <p role="status">{message}</p>}
    {pending && !busy && <div role="status"><p>前の操作の結果を確認してください。同じ操作 ID で安全に再送できます。</p>
      <button disabled={busy} onClick={() => void send(pending)}>送信結果を確認・再送</button></div>}
  </section>;
}
