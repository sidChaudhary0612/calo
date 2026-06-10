import { Component, computed, signal, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MeshService } from '../../core/services/mesh.service';
import { Rider } from '../../core/models/rider.model';

@Component({
  selector: 'app-discovery',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './discovery.component.html',
  styleUrl: './discovery.component.scss',
})
export class DiscoveryComponent implements OnDestroy {
  readonly isScanning    = computed(() => this.mesh.isScanning());
  readonly riders        = computed(() => this.mesh.nearbyRiders());
  readonly connected     = computed(() => this.mesh.meshConnected());
  readonly self          = computed(() => this.mesh.selfRider());
  readonly onlineCount   = computed(() => this.riders().filter(r => r.status === 'online').length);
  readonly pendingInvite = signal('');

  constructor(readonly mesh: MeshService) {}

  ngOnDestroy(): void {
    // Leave scan running — stopped only when user taps Stop
  }

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
    return Array(4).fill(0).map((_, i) => (i < bars ? 1 : 0));
  }

  statusDotClass(status: string): string {
    switch (status) {
      case 'online':  return 'rm-dot--green';
      case 'away':    return 'rm-dot--cyan';
      case 'offline': return 'rm-dot--muted';
      default:        return 'rm-dot--muted';
    }
  }

  statusLabel(status: string): string {
    switch (status) {
      case 'online':  return 'Online';
      case 'away':    return 'Away';
      case 'offline': return 'Offline';
      default:        return 'Unknown';
    }
  }

  /** Map signalAngle (0-359) + signal strength (0-100) → radar blip position (left%, top%). */
  blipPos(rider: Rider): { left: number; top: number } {
    const angle  = (rider.signalAngle ?? 0) * Math.PI / 180;
    const sig    = rider.signal ?? 50;
    const radius = 10 + ((100 - sig) / 100) * 32;
    return {
      left: 50 + radius * Math.cos(angle),
      top:  50 + radius * Math.sin(angle),
    };
  }

  formatDist(m: number | undefined): string {
    if (m == null) return '—';
    return m < 1000 ? Math.round(m) + 'm' : (m / 1000).toFixed(1) + 'km';
  }

  formatSignal(sig: number | undefined): string {
    if (sig == null) return '—';
    return sig + '%';
  }

  formatSpeed(s: number | undefined): string {
    if (s == null) return '—';
    return s.toFixed(0) + ' km/h';
  }

  batteryIcon(pct: number): string {
    if (pct >= 80) return '🔋';
    if (pct >= 40) return '🔋';
    return '🪫';
  }
}
