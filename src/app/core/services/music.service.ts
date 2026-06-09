import { Injectable, inject, signal } from '@angular/core';
import { DataBusService } from './data-bus.service';

export interface Track {
  id:       string;
  title:    string;
  artist:   string;
  duration: number;
}

export type PlaybackState = 'playing' | 'paused' | 'stopped';

const MOCK_TRACKS: Track[] = [
  { id: 't1', title: 'Born to Run',          artist: 'Bruce Springsteen', duration: 270 },
  { id: 't2', title: 'Highway to Hell',       artist: 'AC/DC',            duration: 212 },
  { id: 't3', title: 'Radar Love',            artist: 'Golden Earring',   duration: 395 },
  { id: 't4', title: 'Road to Hell',          artist: 'Chris Rea',        duration: 305 },
  { id: 't5', title: 'Life is a Highway',     artist: 'Tom Cochrane',     duration: 264 },
  { id: 't6', title: 'Runnin\' Down a Dream', artist: 'Tom Petty',        duration: 244 },
];

interface MusicSyncFrame {
  action:    'play' | 'pause' | 'resume' | 'stop';
  trackId?:  string;
  position?: number;
  ts:        number;
}

@Injectable({ providedIn: 'root' })
export class MusicService {
  readonly tracks        = signal<Track[]>(MOCK_TRACKS);
  readonly currentTrack  = signal<Track | null>(null);
  readonly playbackState = signal<PlaybackState>('stopped');
  readonly position      = signal(0);
  readonly sessionActive = signal(false);
  readonly syncedRiders  = signal(0);

  private _ticker:   ReturnType<typeof setInterval> | null = null;
  private _teardown: (() => void) | null = null;
  private _bus = inject(DataBusService);

  constructor() {
    this._teardown = this._bus.register('music', (payload) => {
      try {
        const frame: MusicSyncFrame = JSON.parse(atob(payload));
        this._applySync(frame);
      } catch { /* malformed */ }
    });
  }

  startSession(): void {
    this.sessionActive.set(true);
    this.play(MOCK_TRACKS[0]);
  }

  endSession(): void {
    this.sessionActive.set(false);
    this.stop();
  }

  play(track: Track, broadcast = true): void {
    this.currentTrack.set(track);
    this.playbackState.set('playing');
    this.position.set(0);
    this._clearTicker();
    this._ticker = setInterval(() => {
      const pos = this.position() + 1;
      if (pos >= track.duration) {
        this._nextTrack();
      } else {
        this.position.set(pos);
      }
    }, 1000);
    if (broadcast) {
      this._bus.send('music', { action: 'play', trackId: track.id, position: 0, ts: Date.now() });
    }
  }

  pause(broadcast = true): void {
    this.playbackState.set('paused');
    this._clearTicker();
    if (broadcast) {
      this._bus.send('music', { action: 'pause', ts: Date.now() });
    }
  }

  resume(broadcast = true): void {
    const track = this.currentTrack();
    if (!track) return;
    this.playbackState.set('playing');
    this._ticker = setInterval(() => {
      const pos = this.position() + 1;
      if (pos >= track.duration) {
        this._nextTrack();
      } else {
        this.position.set(pos);
      }
    }, 1000);
    if (broadcast) {
      this._bus.send('music', { action: 'resume', position: this.position(), ts: Date.now() });
    }
  }

  stop(broadcast = true): void {
    this.playbackState.set('stopped');
    this.currentTrack.set(null);
    this.position.set(0);
    this._clearTicker();
    if (broadcast) {
      this._bus.send('music', { action: 'stop', ts: Date.now() });
    }
  }

  skipNext(): void { this._nextTrack(); }

  skipPrev(): void {
    const idx = MOCK_TRACKS.findIndex(t => t.id === this.currentTrack()?.id);
    this.play(MOCK_TRACKS[Math.max(0, idx - 1)]);
  }

  formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private _applySync(frame: MusicSyncFrame): void {
    // Rough latency compensation: offset position by elapsed time since frame was sent
    const latencyMs = Date.now() - frame.ts;
    const latencySec = Math.round(latencyMs / 1000);

    switch (frame.action) {
      case 'play': {
        const track = MOCK_TRACKS.find(t => t.id === frame.trackId);
        if (track) {
          this.play(track, false);
          this.position.set(Math.min((frame.position ?? 0) + latencySec, track.duration));
          this.syncedRiders.update(n => n + 1);
        }
        break;
      }
      case 'pause':
        this.pause(false);
        break;
      case 'resume':
        this.position.set(Math.min((frame.position ?? this.position()) + latencySec, this.currentTrack()?.duration ?? 0));
        this.resume(false);
        break;
      case 'stop':
        this.stop(false);
        this.syncedRiders.set(0);
        break;
    }
  }

  private _nextTrack(): void {
    const idx = MOCK_TRACKS.findIndex(t => t.id === this.currentTrack()?.id);
    this.play(MOCK_TRACKS[(idx + 1) % MOCK_TRACKS.length]);
  }

  private _clearTicker(): void {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
  }

  ngOnDestroy(): void {
    this._clearTicker();
    this._teardown?.();
  }
}
