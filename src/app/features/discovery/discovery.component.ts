import { Component, computed, signal } from '@angular/core';
import { MeshService } from '../../core/services/mesh.service';
import { Rider } from '../../core/models/rider.model';

@Component({
  selector: 'app-discovery',
  templateUrl: './discovery.component.html',
  styleUrl: './discovery.component.scss',
})
export class DiscoveryComponent {
  readonly isScanning   = computed(() => this.mesh.isScanning());
  readonly riders       = computed(() => this.mesh.nearbyRiders());
  readonly connected    = computed(() => this.mesh.meshConnected());
  readonly pendingInvite = signal('');

  constructor(readonly mesh: MeshService) {}

  scan(): void { this.mesh.startScan(); }
  stop(): void { this.mesh.stopScan(); }

  async sendInvite(rider: Rider): Promise<void> {
    if (this.mesh.isInGroup(rider.id)) return;
    this.pendingInvite.set(rider.id);
    try {
      await this.mesh.connectToPeer(rider.id);
    } catch { /* best-effort */ }
    setTimeout(() => this.pendingInvite.set(''), 2000);
  }

  signalBars(sig: number): number[] {
    const bars = Math.round((sig / 100) * 4);
    return Array(4).fill(0).map((_, i) => i < bars ? 1 : 0);
  }

  /** Convert signalAngle (0-359) + signal strength (0-100) → radar x/y position.
   *  Weaker signal = further from centre (less power = further ring).
   *  Returns left%, top% so the blip sits inside the radar circle. */
  blipPos(rider: Rider): { left: number; top: number } {
    const angle = (rider.signalAngle ?? 0) * Math.PI / 180;
    const sig   = rider.signal ?? 50;
    // Stronger signal → closer to centre; weaker → outer ring
    // Map signal 100→0% radius, 0→42% radius (just inside circle boundary)
    const radius = 10 + ((100 - sig) / 100) * 32;
    // Radar circle centre is at 50%, 50%
    const left = 50 + radius * Math.cos(angle);
    const top  = 50 + radius * Math.sin(angle);
    return { left, top };
  }

  formatDist(m: number | undefined): string {
    if (m == null) return '—';
    return m < 1000 ? Math.round(m) + 'm' : (m / 1000).toFixed(1) + 'km';
  }
}
