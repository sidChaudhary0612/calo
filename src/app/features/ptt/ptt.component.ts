import { Component, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PttService, SpeakerEntry } from '../../core/services/ptt.service';
import { MeshService } from '../../core/services/mesh.service';

@Component({
  selector: 'app-ptt',
  imports: [RouterLink],
  templateUrl: './ptt.component.html',
  styleUrl: './ptt.component.scss',
})
export class PttComponent {
  readonly state        = computed(() => this.ptt.state());
  readonly isMuted      = computed(() => this.ptt.isMuted());
  readonly volume       = computed(() => this.ptt.volume());
  readonly speakerName  = computed(() => this.ptt.speakerName());
  readonly txMs         = computed(() => this.ptt.txDurationMs());
  readonly speakerLog   = computed(() => this.ptt.speakerLog());
  readonly members      = computed(() => this.mesh.getGroupMembers());
  readonly inGroup      = computed(() => !!this.mesh.activeGroup());

  constructor(readonly ptt: PttService, readonly mesh: MeshService) {}

  onPttDown(): void  { this.ptt.startTransmit(); }
  onPttUp(): void    { this.ptt.stopTransmit(); }
  toggleMute(): void { this.ptt.toggleMute(); }

  adjustVolume(delta: number): void {
    this.ptt.setVolume(this.ptt.volume() + delta);
  }

  simulateIncoming(): void {
    const members = this.members();
    const name = members.length ? members[0].name : 'Jake Torres';
    this.ptt.simulateIncoming(name);
  }

  formatTx(ms: number): string {
    const s = Math.floor(ms / 1000);
    const tenths = Math.floor((ms % 1000) / 100);
    return `${s}.${tenths}s`;
  }

  formatLogTime(d: Date): string {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}
