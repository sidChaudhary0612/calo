import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MeshService } from '../../core/services/mesh.service';

type View = 'home' | 'create' | 'join';

@Component({
  selector: 'app-groups',
  imports: [FormsModule],
  templateUrl: './groups.component.html',
  styleUrl: './groups.component.scss',
})
export class GroupsComponent {
  readonly group   = computed(() => this.mesh.activeGroup());
  readonly members = computed(() => this.mesh.groupMembers());

  view        = signal<View>('home');
  groupName   = '';
  passcode    = '';
  joinCode    = '';
  joinError   = false;

  constructor(readonly mesh: MeshService) {}

  createGroup(): void {
    if (!this.groupName.trim()) return;
    this.mesh.createGroup(this.groupName.trim());
    this.view.set('home');
    this.groupName = '';
  }

  joinGroup(): void {
    const ok = this.mesh.joinGroup(this.joinCode.trim());
    if (ok) {
      this.view.set('home');
      this.joinCode = '';
      this.joinError = false;
    } else {
      this.joinError = true;
    }
  }

  leaveGroup(): void {
    this.mesh.leaveGroup();
  }

  statusLabel(status: string): string {
    return { forming: 'Forming', riding: 'Riding', paused: 'Paused', ended: 'Ended' }[status] ?? status;
  }
}
