import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { SettingsService } from '../../core/services/settings.service';
import { MeshService } from '../../core/services/mesh.service';

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss',
})
export class OnboardingComponent {
  name = '';
  error = signal('');

  constructor(
    private settings: SettingsService,
    private mesh: MeshService,
    private router: Router,
  ) {}

  confirm(): void {
    const trimmed = this.name.trim();
    if (trimmed.length < 2) {
      this.error.set('Name must be at least 2 characters.');
      return;
    }
    this.settings.saveRiderName(trimmed);
    this.mesh.applyRiderName(trimmed);
    this.router.navigate(['/dashboard']);
  }
}
