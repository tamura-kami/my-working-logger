// 作成・再開は必ず利用者のクリックから呼ぶ（Safari の自動再生制限）。
export class TimerSound {
  private context: AudioContext | null = null;
  async enable(): Promise<boolean> {
    try {
      const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) return false;
      this.context ??= new Constructor();
      if (this.context.state !== 'running') await this.context.resume();
      return this.context.state === 'running';
    } catch { return false; }
  }
  play(): boolean {
    const context = this.context;
    if (!context || context.state !== 'running') return false;
    try {
      for (let i = 0; i < 3; i++) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const at = context.currentTime + i * 0.3;
        oscillator.frequency.value = 880;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(at); oscillator.stop(at + 0.24);
      }
      return true;
    } catch { return false; }
  }
  close() { void this.context?.close().catch(() => {}); this.context = null; }
}
