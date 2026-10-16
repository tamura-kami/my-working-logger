import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import styles from './App.module.css';

// タイマーから他画面の依存を読み込まない。画面ごとに直接 import する。
const Timer = lazy(() => import('./pages/Timer'));
const Summary = lazy(() => import('./pages/Summary'));
const Projects = lazy(() => import('./pages/Projects'));

class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <p role="alert">画面を読み込めませんでした。<a href="/">記録するページを開く</a></p>
      : this.props.children;
  }
}

export default function App() {
  const [timerActive, setTimerActive] = useState(false);
  return <div className={timerActive ? styles.timerShell : styles.shell}>
    {!timerActive && <><header className={styles.brand}>My Working Logger<span>日々の作業を記録する</span></header>
    <nav className={styles.nav} aria-label="メインナビゲーション">
      <NavLink to="/" end>記録する</NavLink>
      <NavLink to="/summary">実績・サマリ</NavLink>
      <NavLink to="/projects">作業管理</NavLink>
    </nav></>}
    <main className={timerActive ? styles.timerMain : styles.main}>
      <PageErrorBoundary><Suspense fallback={<p role="status">読み込み中…</p>}>
        <Routes>
          <Route path="/" element={<Timer onActiveChange={setTimerActive} />} />
          <Route path="/summary" element={<Summary />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="*" element={<><h1>画面が見つかりません</h1><NavLink to="/">記録するページへ</NavLink></>} />
        </Routes>
      </Suspense></PageErrorBoundary>
    </main>
  </div>;
}
