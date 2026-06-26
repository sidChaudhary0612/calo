import { Component, computed, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { RtcVoiceService } from '../../core/services/rtc-voice.service';
import { MeshService } from '../../core/services/mesh.service';

@Component({
  selector: 'app-ptt',
  imports: [RouterLink],
  templateUrl: './ptt.component.html',
  styleUrl: './ptt.component.scss',
})
export class PttComponent {
  readonly live      = computed(() => this.rtc.live());
  readonly muted     = computed(() => this.rtc.muted());
  readonly volume    = computed(() => this.rtc.volume());
  readonly peerCount = computed(() => this.rtc.peerCount());
  readonly members   = computed(() => this.mesh.getGroupMembers());
  readonly inGroup   = computed(() => !!this.mesh.activeGroup());

  /** True while any remote stream is above the speaking threshold. */
  readonly someoneSpeaking = computed(() => {
    for (const level of this.rtc.speakerLevels().values()) if (level > 0) return true;
    return false;
  });

  readonly micError = signal(false);

  constructor(readonly rtc: RtcVoiceService, readonly mesh: MeshService) {}

  async toggleLive(): Promise<void> {
    if (this.live()) {
      this.rtc.leaveVoice();
      return;
    }
    this.micError.set(false);
    const ok = await this.rtc.goLive();
    if (!ok) this.micError.set(true);
  }

  toggleMute(): void { this.rtc.toggleMute(); }

  adjustVolume(delta: number): void {
    this.rtc.setVolume(this.rtc.volume() + delta);
  }
}
