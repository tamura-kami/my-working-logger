import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PomodoroSettings, Project } from '../../shared/contracts';
import { cycleDurations, formatDuration, remainingTime } from '../../shared/timing';
import { api, errorMessage } from '../api';
import { defaultPomodoro, validPomodoro } from '../../shared/pomodoro';
import { loadPomodoro, savePomodoro, loadTimerMode, saveTimerMode } from '../pomodoroSettings';
import { TimerSound } from '../timerSound';
import { beginNext, emptyLocalTimer, expireLocalTimer, finishLocalTimer, pauseLocalTimer, readLocalTimer,
  resumeLocalTimer, startLocalTimer, writeLocalTimer, type LocalTimer } from '../localTimer';
import styles from './Timer.module.css';
import ActiveTimer from '../components/ActiveTimer';

export default function Timer({ onActiveChange }: { onActiveChange?: (active: boolean) => void }) {
  const [state, setState] = useState<LocalTimer>(emptyLocalTimer);
  const current = useRef(state);
  const [loaded, setLoaded] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'normal' | 'pomodoro'>('normal');
  const [settings, setSettings] = useState<PomodoroSettings>({ ...defaultPomodoro });
  const [storageError, setStorageError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const mounted = useRef(false);
  const [, setTick] = useState(0);
  const sound = useRef(new TimerSound());
  const [soundNotice, setSoundNotice] = useState('開始・再開時に終了音を有効にします。再読込後は「終了音を確認」を押してください。');
  async function enableSound(test = false) {
    const enabled = await sound.current.enable();
    if (test && enabled) sound.current.play();
    setSoundNotice(enabled ? '終了音は有効です。集中・休憩の満了時に鳴ります。' : '終了音を有効にできません。ブラウザと端末の音量設定を確認してください。');
  }
  const commit = useCallback((next: LocalTimer): boolean => {
    try {
      writeLocalTimer(next); current.current = next;
      if (mounted.current) { setState(next); setStorageError(''); }
      return true;
    } catch {
      if (mounted.current) setStorageError('タイマー・実績を保存できません。ブラウザのストレージ設定や空き容量を確認してください。操作は確定していません。');
      return false;
    }
  }, []);
  const flush = useCallback(async () => {
    if (sending.current || !mounted.current) return;
    sending.current = true; setBusy(true); setError('');
    try {
      while (mounted.current && current.current.pending.length) {
        const record = current.current.pending[0];
        await api('/sessions', { method: 'POST', body: JSON.stringify(record) });
        if (!mounted.current) return;
        if (!commit({ ...current.current, pending: current.current.pending.filter((s) => s.id !== record.id) })) return;
        setMessage('作業実績を保存しました。');
      }
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }, [commit]);
  const chooseProject = useCallback((id: string) => {
    setSelected(id); setSettings(loadPomodoro(id)); setMode(loadTimerMode(id));
  }, []);
  const refresh = useCallback(async () => {
    try {
      const list = await api<{ projects: Project[] }>('/projects');
      if (!mounted.current) return;
      setProjects(list.projects); chooseProject(list.projects[0]?.id ?? '');
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
  }, [chooseProject]);
  useEffect(() => {
    mounted.current = true;
    try {
      const saved = readLocalTimer();
      current.current = saved; setState(saved);
      commit(expireLocalTimer(saved, Date.now(), false));
      void flush();
    } catch (e) {
      setBlocked(true); setStorageError(e instanceof Error ? e.message : '保存されたタイマーを読み込めません。');
    }
    setLoaded(true); void refresh();
    let lastTick = Date.now();
    let suspended = document.hidden;
    const advance = (automatic: boolean) => {
      const before = current.current;
      const next = expireLocalTimer(before, Date.now(), automatic);
      if (next !== before && commit(next)) { sound.current.play(); void flush(); }
    };
    const interval = window.setInterval(() => {
      const now = Date.now();
      if (!document.hidden) { advance(!suspended && now - lastTick < 5000); suspended = false; setTick((t) => t + 1); }
      else suspended = true;
      lastTick = now;
    }, 250);
    const restore = () => {
      if (document.hidden) { suspended = true; return; }
      advance(false); suspended = false; lastTick = Date.now(); setTick((t) => t + 1); void flush();
    };
    const hide = () => { suspended = true; };
    const online = () => { void flush(); };
    document.addEventListener('visibilitychange', restore);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', restore);
    window.addEventListener('focus', restore); window.addEventListener('online', online);
    return () => {
      mounted.current = false; sound.current.close(); clearInterval(interval);
      document.removeEventListener('visibilitychange', restore);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', restore);
      window.removeEventListener('focus', restore); window.removeEventListener('online', online);
    };
  }, [commit, flush, refresh]);
  function editSettings(key: keyof PomodoroSettings, value: number) {
    const next = { ...settings, [key]: value }; setSettings(next);
    if (validPomodoro(next)) setStorageError(savePomodoro(selected, next) ? '' : 'このブラウザでは設定を保存できません。');
  }
  function act(action: 'start' | 'pause' | 'resume' | 'finish' | 'next' | 'skip') {
    if (blocked || !loaded) return;
    let value = current.current;
    if (action === 'finish' && !window.confirm(value.timer?.mode === 'pomodoro' ? 'ポモドーロを終了しますか？ここまでの集中時間をまとめて保存します。' : 'この作業を終了して実績を保存しますか？')) return;
    const now = Date.now();
    value = expireLocalTimer(value, now, false);
    if (['start', 'resume', 'next', 'skip'].includes(action)) void enableSound();
    if (action === 'start') {
      const project = projects.find((p) => p.id === selected);
      if (!project || value.timer || (mode === 'pomodoro' && !validPomodoro(settings))) return;
      value = startLocalTimer(value, project, mode, settings, now);
    } else if (!value.timer) return;
    else if (action === 'finish') {
      const count = value.pending.length;
      value = finishLocalTimer(value, now);
      setMessage(value.pending.length > count ? '作業実績を保存しています。' : 'タイマーを終了しました。');
    } else if (action === 'next' || (action === 'skip' && value.timer.phase !== 'focus')) value = beginNext(value, now);
    else if (action === 'pause' && value.timer.status === 'running') value = pauseLocalTimer(value, now);
    else if (action === 'resume' && value.timer.status === 'paused') value = resumeLocalTimer(value, now);
    if (commit(value) && value.pending.length) void flush();
  }
  const timer = state.timer;
  const now = Date.now();
  const time = timer ? cycleDurations(timer, now) : { active: 0, paused: 0, elapsed: 0 };
  const remaining = timer ? remainingTime(timer, now) : null;
  const effectiveMode = timer?.mode ?? mode;
  const activeSettings = timer?.pomodoro ?? settings;
  const primaryTime = effectiveMode === 'pomodoro' ? remaining ?? settings.focus_minutes * 60000 : time.active;
  const controlsDisabled = blocked || !loaded;
  const pending = state.pending.length > 0;
  const active = !!timer;
  useLayoutEffect(() => {
    onActiveChange?.(active);
    return () => onActiveChange?.(false);
  }, [active, onActiveChange]);
  if (active) return <ActiveTimer timer={timer!} milliseconds={primaryTime} disabled={controlsDisabled}
    busy={busy} error={storageError || error} pending={!!pending} onAction={act} onRefresh={() => void flush()}
    onRetry={() => void flush()} />;
  return <section aria-labelledby="timer-heading">
    <h1 id="timer-heading">タイマー</h1><p>今日の作業を記録します。</p>
    {!loaded ? <p role="status">読み込み中…</p> : <>
      <label className={styles.select}>作業<select value={selected} disabled={controlsDisabled || !projects.length} onChange={(e) => chooseProject(e.target.value)}>
        {!projects.length && <option value="">作業がありません</option>}
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
      {!active && <fieldset className={styles.modePicker} disabled={controlsDisabled || !selected}>
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
        <p className={styles.time}>{formatDuration(effectiveMode === 'pomodoro' ? settings.focus_minutes * 60000 : 0)}</p>
        <button disabled={controlsDisabled || !selected || (mode === 'pomodoro' && !validPomodoro(settings))} onClick={() => act('start')}>開始</button>
      </div>
      {effectiveMode === 'pomodoro' && <details className={styles.settings} open={!active}>
        <summary>ポモドーロ設定{active && '（開始時の設定）'}</summary>
        <fieldset disabled={controlsDisabled || active || !selected}>
          <legend>作業別の設定</legend>
          {([['focus_minutes', '集中（分）'], ['short_break_minutes', '短い休憩（分）'], ['long_break_minutes', '長い休憩（分）'], ['long_break_every', '長い休憩までの集中回数']] as const).map(([key, label]) =>
            <label key={key}>{label}<input type="number" inputMode="numeric" min={1} max={key === 'long_break_every' ? 20 : 180} step={1}
              value={Number.isFinite(activeSettings[key]) ? activeSettings[key] : ''} onChange={(e) => editSettings(key, e.target.valueAsNumber)} /></label>)}
        </fieldset>
        <p>{!active ? '作業ごとに、このブラウザに自動保存します。時間は1〜180分、回数は1〜20回で指定してください。' : 'このポモドーロを終了するまで、開始時の設定を使用します。'}</p>
        {!active && !validPomodoro(settings) && <p role="alert">時間と回数を指定範囲の整数で入力してください。</p>}
      </details>}
      {!projects.length && !active && <p><Link to="/projects">作業管理</Link>で作業を追加してください。</p>}
      <p className={styles.note}>{effectiveMode === 'pomodoro' ? '画面を開いている間、集中と休憩が自動で切り替わります。長い休憩の直前に集中時間をまとめて保存し、短い休憩と一時停止は休止時間に含めます。復帰時に満了していた場合は00:00で停止し、操作して次へ進みます。' : 'ブラウザを閉じても計測は続きます。一時停止中はその状態で復元します。'}</p>
    </>}
    <p><button onClick={() => void enableSound(true)}>終了音を確認</button> {soundNotice}</p>
    <p className={styles.note}>画面を閉じた状態や端末のスリープ中は終了音を鳴らせません。</p>
    {storageError && <p role="alert">{storageError}</p>}
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => void refresh()}>状態を再読み込み</button></p>}
    {message && <p role="status">{message}</p>}
    {pending && <div role="status"><p>未保存の実績が {state.pending.length} 件あります。</p><button disabled={busy} onClick={() => void flush()}>実績を再送</button></div>}
  </section>;
}
