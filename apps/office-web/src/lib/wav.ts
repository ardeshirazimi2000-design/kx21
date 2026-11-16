/**
 * Converts any audio the browser can decode (a recording, MP3, WAV, OGG, M4A…) to what Asterisk plays natively:
 * 8 kHz, mono, 16-bit PCM WAV. Quiet recordings are raised so the peak is near full scale.
 */
export async function toPhoneWav(input: Blob): Promise<Blob> {
  const Ctx: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await input.arrayBuffer());
  } catch {
    throw new Error('این فایل صوتی خوانده نشد. فایل MP3 یا WAV بدهید.');
  } finally {
    void ctx.close();
  }
  if (decoded.duration > 180) throw new Error('پیام نباید بیش از سه دقیقه باشد.');
  if (decoded.duration < 0.5) throw new Error('پیام کوتاه‌تر از نیم ثانیه است.');
  const rate = 8000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const samples = (await off.startRendering()).getChannelData(0);
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 && peak < 0.7 ? 0.9 / peak : 1;

  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s * gain)) * 0x7fff, true));
  return new Blob([buf], { type: 'audio/wav' });
}

/** Microphone recording needs a secure page (HTTPS or localhost) and MediaRecorder. */
export const canRecord = () => !!(window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && 'MediaRecorder' in window);
