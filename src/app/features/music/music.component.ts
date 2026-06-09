import { Component, computed } from '@angular/core';
import { MusicService, Track } from '../../core/services/music.service';

@Component({
  selector: 'app-music',
  templateUrl: './music.component.html',
  styleUrl: './music.component.scss',
})
export class MusicComponent {
  readonly tracks        = computed(() => this.music.tracks());
  readonly current       = computed(() => this.music.currentTrack());
  readonly state         = computed(() => this.music.playbackState());
  readonly position      = computed(() => this.music.position());
  readonly session       = computed(() => this.music.sessionActive());
  readonly syncedRiders  = computed(() => this.music.syncedRiders());

  constructor(readonly music: MusicService) {}

  progress(track: Track | null): number {
    if (!track) return 0;
    return Math.round((this.position() / track.duration) * 100);
  }

  togglePlay(): void {
    if (this.state() === 'playing') this.music.pause();
    else if (this.state() === 'paused') this.music.resume();
    else if (this.current()) this.music.resume();
  }

  selectTrack(track: Track): void {
    this.music.play(track);
  }
}
