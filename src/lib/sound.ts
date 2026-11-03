/* ============================================================================
   提示音（零 React）

   用 Web Audio API 现场合成短促双音，零体积、不引音频文件。
   浏览器要求"音频在用户手势后才能播放" —— 所以 `unlockAudio()` 必须在
   首次用户手势（如点击"开始提醒"）里调用一次，把 AudioContext 解锁；
   之后 `playBeep()` 才能真的出声。任何环境不支持 / 构造失败都静默降级。
   ========================================================================= */

/** 模块级唯一的 AudioContext；首次 unlockAudio 时惰性创建 */
let audioContext: AudioContext | null = null;

type AudioContextCtor = typeof AudioContext;

function getAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  try {
    const Ctor: AudioContextCtor | undefined =
      (globalThis as { AudioContext?: AudioContextCtor }).AudioContext ??
      (globalThis as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) return null;
    audioContext = new Ctor();
    return audioContext;
  } catch {
    return null;
  }
}

/**
 * 解锁音频：首次用户手势时调用（resume 被挂起的上下文）。
 * 不可用（无 AudioContext / 环境禁声）时 no-op，绝不抛。
 */
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    /* 个别环境 resume 会抛：忽略 */
  }
}

/**
 * 合成短促双音 + 增益包络防爆音。
 * 两个 880Hz 短音，每段带 10ms 渐入 / 渐出，避免方波直连扬声器产生"咔哒"爆音。
 * 任何异常静默吞掉（提示音失败不该影响主流程）。
 */
export function playBeep(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const beep = (start: number, freq: number): void => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // 增益包络：0 → 0.2（10ms）→ 0（150ms），渐入渐出防爆音
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.2, now + start + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + start + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.16);
    };
    beep(0, 880);
    beep(0.2, 880);
  } catch {
    /* 合成失败：静默跳过 */
  }
}
