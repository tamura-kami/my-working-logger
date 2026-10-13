import { useEffect, useRef } from 'react';
import type { TimerState } from '../../shared/contracts';
import { formatDuration } from '../../shared/timing';
import styles from './ActiveTimer.module.css';

type Action = 'pause' | 'resume' | 'finish' | 'skip' | 'next';
interface Props {
  timer: TimerState;
  milliseconds: number;
  disabled: boolean;
  busy: boolean;
  error: string;
  pending: boolean;
  onAction: (action: Action) => void;
  onRefresh: () => void;
  onRetry: () => void;
}
function Icon({ name }: { name: 'pause' | 'play' | 'stop' | 'skip' | 'retry' }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {name === 'pause' ? <><path d="M8 5v14M16 5v14" /></> :
      name === 'play' ? <path d="m8 5 11 7-11 7Z" /> :
      name === 'stop' ? <rect x="5" y="5" width="14" height="14" rx="1" /> :
      name === 'skip' ? <><path d="m5 5 10 7-10 7ZM19 5v14" /></> :
      <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" /></>}
  </svg>;
}
export default function ActiveTimer({ timer, milliseconds, disabled, busy, error, pending, onAction, onRefresh, onRetry }: Props) {
  const display = useRef<HTMLParagraphElement>(null);
  useEffect(() => { display.current?.focus(); }, []);
  const pomodoro = timer.mode === 'pomodoro';
  const rounded = pomodoro ? Math.ceil(milliseconds / 1000) * 1000 : milliseconds;
  const fullTime = formatDuration(Number.isFinite(rounded) ? rounded : 0);
  const time = pomodoro && rounded < 3600000 ? fullTime.slice(3) : fullTime;
  const waiting = timer.status === 'expired';
  const currentFocus = timer.completed_focus + (timer.phase === 'focus' && !waiting ? 1 : 0);
  const resume = timer.status === 'paused' || waiting;
  const primary: Action = waiting ? 'next' : resume ? 'resume' : 'pause';
  const color = !pomodoro ? '#253E49' : timer.phase === 'focus' ? '#C94F45' : '#448A70';
  return <section className={styles.screen} style={{ backgroundColor: color }} aria-label={pomodoro ? 'ポモドーロタイマー' : '通常タイマー'} aria-busy={busy}>
    <div className={styles.display}>
      <p ref={display} tabIndex={-1} role="timer" aria-label={pomodoro ? '残り時間' : '実作業時間'}
        className={`${styles.time} ${time.length > 5 ? styles.hours : ''}`}>{time}</p>
      {pomodoro && <p className={styles.progress} aria-label="サイクル内の集中回数">{currentFocus} / {timer.pomodoro!.long_break_every}</p>}
    </div>
    {waiting && !error && !pending && <p className={styles.notice} role="status">フェーズが満了しました。次のフェーズを開始してください。</p>}
    <div className={styles.controls}>
      <button type="button" aria-label={waiting ? '次のフェーズを開始' : resume ? '再開' : '一時停止'} disabled={disabled} onClick={() => onAction(primary)}><Icon name={resume ? 'play' : 'pause'} /></button>
      {pomodoro && timer.phase !== 'focus' && <button type="button" className={styles.secondary} aria-label="休憩をスキップ" disabled={disabled} onClick={() => onAction('skip')}><Icon name="skip" /></button>}
      <button type="button" aria-label={pomodoro ? 'ポモドーロを終了' : '終了して保存'} disabled={disabled} onClick={() => onAction('finish')}><Icon name="stop" /></button>
      {pending && !busy ? <button type="button" aria-label="送信結果を確認・再送" onClick={onRetry}><Icon name="retry" /></button> :
        error && <button type="button" aria-label="状態を再読み込み" title={error} disabled={busy} onClick={onRefresh}><Icon name="retry" /></button>}
    </div>
    {error && <p role="alert" className={styles.notice}>{error}</p>}
    {pending && !busy && !error && <p role="status" className={styles.notice}>未保存の実績があります。再送ボタンから再送できます。</p>}
  </section>;
}
