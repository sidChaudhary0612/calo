import { Injectable, signal } from '@angular/core';

const KEY_NAME = 'rath_rider_name';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly riderName = signal<string>(localStorage.getItem(KEY_NAME) ?? '');

  get hasProfile(): boolean {
    return this.riderName().trim().length > 0;
  }

  saveRiderName(name: string): void {
    const trimmed = name.trim();
    localStorage.setItem(KEY_NAME, trimmed);
    this.riderName.set(trimmed);
  }
}
