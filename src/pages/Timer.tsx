import styles from './Timer.module.css';
export default function Timer() {
  return <section aria-labelledby="timer-heading">
    <h1 id="timer-heading">タイマー</h1>
    <p>今日の作業を、ここから。</p>
    <div className={styles.panel}>
      <p className={styles.time} aria-label="未開始、0時間0分0秒">00:00:00</p>
      <p>まだ作業が登録されていません。</p>
      <p>作業選択とタイマー操作は今後の実装で利用できるようになります。</p>
    </div>
  </section>;
}
