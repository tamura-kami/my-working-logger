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
      const ready = context === this.context && context.state === 'running';
      if (!ready) console.warn('Timer sound resume incomplete', { state: context.state });
      return ready;
    } catch (error) { console.warn('Timer sound resume failed', error); return false; }
    finally { clearTimeout(timeout); }
  }
  // 復帰時は既に有効化された音声だけを再開する。
  async restore(): Promise<boolean> {
    const context = this.context;
    const ready = !!context && (context.state === 'running' || await this.resume(context));
    if (context === this.context) this.onStateChange?.(ready);
    return ready;
  }
  async enable(): Promise<boolean> {
    try {
      // running と報告されても無音になる Safari の状態を引き継がない。
      this.close();
      const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) throw new Error('Web Audio API unavailable');
      const context = new Constructor();
      this.context = context;
      context.onstatechange = () => {
        if (this.context === context) this.onStateChange?.(context.state === 'running');
      };
      return await this.restore();
    } catch (error) { console.warn('Timer sound initialization failed', error); this.onStateChange?.(false); return false; }
  }
  play(): boolean {
    const context = this.context;
    if (!context || context.state !== 'running') {
      console.warn('Timer sound playback unavailable', { state: context?.state ?? 'uninitialized' });
      this.onStateChange?.(false); return false;
    }
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
    } catch (error) { console.warn('Timer sound playback failed', error); this.onStateChange?.(false); return false; }
  }
  close() {
    const context = this.context; this.context = null;
    if (context) {
      context.onstatechange = null;
      try { void context.close().catch((error) => console.warn('Timer sound close failed', error)); }
      catch (error) { console.warn('Timer sound close failed', error); }
    }
  }
}
