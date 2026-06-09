import { Injectable, OnDestroy, signal } from '@angular/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { P2pSocket } from '../plugins/p2p-socket.plugin';

export type PTTState = 'idle' | 'transmitting' | 'receiving';

export interface SpeakerEntry {
  name:      string;
  startedAt: Date;
  durationMs?: number;
}

// Channel tag used for PTT audio frames
const CHANNEL_PTT = 'ptt-audio';

// MediaRecorder MIME preference order
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
];

function pickMime(): string {
  return MIME_CANDIDATES.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
}

@Injectable({ providedIn: 'root' })
export class PttService implements OnDestroy {

  // ── Public state ────────────────────────────────────────────────────────
  readonly state        = signal<PTTState>('idle');
  readonly isMuted      = signal(false);
  readonly volume       = signal(80);
  readonly speakerId    = signal<string | null>(null);
  readonly speakerName  = signal<string | null>(null);
  readonly txDurationMs = signal(0);
  readonly speakerLog   = signal<SpeakerEntry[]>([]);

  // ── Private ─────────────────────────────────────────────────────────────
  private _stream:   MediaStream   | null = null;
  private _recorder: MediaRecorder | null = null;
  private _audioCtx: AudioContext  | null = null;
  private _gainNode: GainNode      | null = null;

  private _txStart   = 0;
  private _txTicker: ReturnType<typeof setInterval> | null = null;
  private _rxTimeout: ReturnType<typeof setTimeout>  | null = null;

  private _socketListener: { remove(): void } | null = null;

  // ────────────────────────────────────────────────────────────────────────

  constructor() {
    this._initSocket();
  }

  // ─── Transmit ────────────────────────────────────────────────────────────

  async startTransmit(): Promise<void> {
    if (this.isMuted() || this.state() !== 'idle') return;

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
    } catch {
      return;
    }

    const mime = pickMime();
    const options: MediaRecorderOptions = mime ? { mimeType: mime, audioBitsPerSecond: 16000 } : {};

    try {
      this._recorder = new MediaRecorder(this._stream, options);
    } catch {
      this._recorder = new MediaRecorder(this._stream);
    }

    this._recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._sendAudioChunk(e.data);
    };

    this._recorder.start(80);  // emit chunks every 80 ms for low latency
    this.state.set('transmitting');
    this._txStart = Date.now();
    this._txTicker = setInterval(() => this.txDurationMs.set(Date.now() - this._txStart), 100);

    Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
  }

  stopTransmit(): void {
    if (this.state() !== 'transmitting') return;

    this._recorder?.stop();
    this._stream?.getTracks().forEach(t => t.stop());
    this._recorder = null;
    this._stream   = null;

    if (this._txTicker) { clearInterval(this._txTicker); this._txTicker = null; }
    this.txDurationMs.set(0);
    this.state.set('idle');

    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
  }

  // ─── Controls ────────────────────────────────────────────────────────────

  toggleMute(): void {
    this.isMuted.update(v => !v);
    if (this.state() === 'transmitting') this.stopTransmit();
  }

  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(100, v));
    this.volume.set(clamped);
    if (this._gainNode) this._gainNode.gain.value = clamped / 100;
  }

  // ── Dev helper ────────────────────────────────────────────────────────────

  simulateIncoming(name: string): void {
    this._onIncomingStart(name);
    setTimeout(() => this._onIncomingEnd(name), 3000);
  }

  // ─── Socket plumbing ─────────────────────────────────────────────────────

  private async _initSocket(): Promise<void> {
    this._socketListener = await P2pSocket.addListener('frameReceived', frame => {
      if (frame.channel !== CHANNEL_PTT) return;
      this._playAudioChunk(frame.payload, frame.peerAddress);
    });
  }

  private _sendAudioChunk(blob: Blob): void {
    const reader = new FileReader();
    reader.onloadend = () => {
      const b64 = (reader.result as string).split(',')[1];
      if (b64) {
        P2pSocket.send({ channel: CHANNEL_PTT, payload: b64 }).catch(() => {});
      }
    };
    reader.readAsDataURL(blob);
  }

  // ─── Audio playback ───────────────────────────────────────────────────────

  private _playAudioChunk(base64: string, peerAddr: string): void {
    this._ensureAudioContext();

    const binary = atob(base64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);

    this._audioCtx!.decodeAudioData(buf.buffer.slice(0)).then(decoded => {
      const src = this._audioCtx!.createBufferSource();
      src.buffer = decoded;
      src.connect(this._gainNode!);
      src.start();

      // Update state to "receiving" for the duration of this chunk
      if (this.state() !== 'transmitting') {
        const peerName = peerAddr === '127.0.0.1' ? 'Echo' : peerAddr;
        this._onIncomingStart(peerName);
        src.onended = () => this._onIncomingEnd(peerName);
      }
    }).catch(() => {
      // Chunk arrived before header — common with first Opus frame; ignore
    });
  }

  private _ensureAudioContext(): void {
    if (this._audioCtx) return;
    this._audioCtx = new AudioContext();
    this._gainNode = this._audioCtx.createGain();
    this._gainNode.gain.value = this.volume() / 100;
    this._gainNode.connect(this._audioCtx.destination);
  }

  // ─── Receiving state helpers ──────────────────────────────────────────────

  private _onIncomingStart(name: string): void {
    if (this._rxTimeout) { clearTimeout(this._rxTimeout); this._rxTimeout = null; }
    if (this.state() === 'transmitting') return;
    this.state.set('receiving');
    this.speakerName.set(name);
  }

  private _onIncomingEnd(name: string): void {
    if (this.state() !== 'receiving') return;
    // Add 300 ms silence tail before going back to idle
    this._rxTimeout = setTimeout(() => {
      this.state.set('idle');
      const entry: SpeakerEntry = { name, startedAt: new Date() };
      this.speakerLog.update(log => [entry, ...log].slice(0, 10));
      this.speakerName.set(null);
      this._rxTimeout = null;
    }, 300);
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  ngOnDestroy(): void {
    this.stopTransmit();
    this._socketListener?.remove();
    this._audioCtx?.close();
    if (this._rxTimeout) clearTimeout(this._rxTimeout);
  }
}
