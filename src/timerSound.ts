// 新規作成は利用者のクリックから行い、画面復帰時には既存の音声の再開を試す。
export class TimerSound {
  private context: AudioContext | null = null;
  constructor(private readonly onStateChange?: (ready: boolean) => void) {}
  private async resume(context: AudioContext): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        context.resume(),
        new Promise<void>((resolve) => { timeout = setTimeout(resolve, 1500); }),
      ]);
      return context === this.context && context.state === 'running';
    } catch { return false; }
    finally { clearTimeout(timeout); }
  }
  // 復帰時は既に有効化された音声だけを再開する。
  async restore(): Promise<boolean> {
    const context = this.context;
    const ready = !!context && (context.state === 'running' || await this.resume(context));
    if (context === this.context) this.onStateChange?.(ready);
    return ready;
  }
  async enable(recreate = false): Promise<boolean> {
    try {
      const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) return false;
      // iPad で中断後に復帰不能になった context は、利用者の操作中に作り直す。
      if (this.context && (recreate || this.context.state !== 'running')) this.close();
      if (!this.context) {
        const context = new Constructor();
        this.context = context;
        context.onstatechange = () => {
          if (this.context === context) this.onStateChange?.(context.state === 'running');
        };
      }
      return await this.restore();
    } catch { this.onStateChange?.(false); return false; }
  }
  play(): boolean {
    const context = this.context;
    if (!context || context.state !== 'running') { this.onStateChange?.(false); return false; }
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
    } catch { this.onStateChange?.(false); return false; }
  }
  close() {
    const context = this.context; this.context = null;
    if (context) { context.onstatechange = null; void context.close().catch(() => {}); }
  }
}
