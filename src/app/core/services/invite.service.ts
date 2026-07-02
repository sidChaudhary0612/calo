import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { DataBusService } from './data-bus.service';
import { MeshService } from './mesh.service';
import { SettingsService } from './settings.service';
import { BlePlugin, InviteReceivedEvent } from '../plugins/ble.plugin';

export interface InvitePayload {
  type:        'invite' | 'response';
  fromId:      string;
  fromName:    string;
  groupId:     string;
  groupName:   string;
  passcode:    string;
  accepted?:   boolean;   // only present on type='response'
  ts:          number;
}

export interface PendingInvite {
  payload:     InvitePayload;
  peerAddress: string;
}

@Injectable({ providedIn: 'root' })
export class InviteService implements OnDestroy {

  // Incoming invite waiting for the user to accept / decline
  readonly pendingInvite = signal<PendingInvite | null>(null);

  // Per-rider sending state: riderId → 'sending' | 'sent' | 'accepted' | 'declined'
  readonly sentState = signal<Map<string, 'sending' | 'sent' | 'accepted' | 'declined'>>(new Map());

  private _bus      = inject(DataBusService);
  private _mesh     = inject(MeshService);
  private _settings = inject(SettingsService);
  private _teardown: (() => void) | null = null;
  private _bleListener: { remove(): void } | null = null;

  constructor() {
    // Primary path: invites/responses delivered over BLE GATT write. This works
    // before any Wi-Fi Direct / TCP link exists, so it's the reliable channel.
    BlePlugin.addListener('inviteReceived', (e: InviteReceivedEvent) => this._onGattInvite(e))
      .then(l => { this._bleListener = l; });

    // Secondary path: kept for when a socket already exists (harmless otherwise).
    this._teardown = this._bus.register('invite', (payload, peerAddress) => {
      try {
        const msg: InvitePayload = JSON.parse(atob(payload));
        if (msg.type === 'invite')   this._onInviteReceived(msg, peerAddress);
        if (msg.type === 'response') this._onResponseReceived(msg);
      } catch { /* malformed */ }
    });
  }

  // ─── Leader sends invite to a nearby rider (over BLE GATT) ────────────────

  async sendInvite(riderId: string): Promise<void> {
    const group = this._mesh.activeGroup();
    if (!group?.passcode) return;

    const bleAddr = this._mesh.getBleAddress(riderId);
    if (!bleAddr) return;

    this._setSentState(riderId, 'sending');

    // Compact wire payload: "J" + passcode(4) + groupName (<=14). The invitee only
    // needs the passcode to auto-join; fromName is resolved locally from its beacon.
    const wire = 'J' + group.passcode + group.name.slice(0, 14);

    try {
      await BlePlugin.sendInvite({ deviceAddress: bleAddr, payload: wire });
      this._setSentState(riderId, 'sent');
    } catch {
      this._setSentState(riderId, 'declined');
      setTimeout(() => this._clearSentState(riderId), 3000);
      return;
    }

    // Auto-clear sent state after 30s if no response
    setTimeout(() => {
      const map = this.sentState();
      if (map.get(riderId) === 'sent') {
        this._setSentState(riderId, 'declined');
        setTimeout(() => this._clearSentState(riderId), 3000);
      }
    }, 30000);
  }

  // ─── Invitee accepts ──────────────────────────────────────────────────────

  accept(): void {
    const pending = this.pendingInvite();
    if (!pending) return;

    const { payload, peerAddress } = pending;

    // Join the group using the passcode — now reliable via the beacon (Fix A) and
    // the socket-on-connect wiring (Fix C).
    this._mesh.joinGroup(payload.passcode);

    // Tell the leader we accepted (best-effort; even if this write is lost, our
    // post-join beacon carrying g=passcode triggers the leader's auto-join).
    BlePlugin.sendInvite({ deviceAddress: peerAddress, payload: 'A' + payload.passcode }).catch(() => {});
    this.pendingInvite.set(null);
  }

  // ─── Invitee declines ─────────────────────────────────────────────────────

  decline(): void {
    const pending = this.pendingInvite();
    if (!pending) return;

    const { payload, peerAddress } = pending;
    BlePlugin.sendInvite({ deviceAddress: peerAddress, payload: 'D' + payload.passcode }).catch(() => {});
    this.pendingInvite.set(null);
  }

  // ─── GATT invite/response handling (primary path) ─────────────────────────

  private _onGattInvite(e: InviteReceivedEvent): void {
    const kind = e.payload.charAt(0);   // 'J' invite | 'A' accept | 'D' decline
    const passcode = e.payload.slice(1, 5);

    if (kind === 'J') {
      // Incoming invite → show the banner (ignored if we're already in a group).
      if (this._mesh.activeGroup()) return;
      const groupName = e.payload.slice(5) || 'Ride Group';
      const fromName  = this._mesh.getRiderNameByBleAddress(e.fromAddress) || 'A rider';
      const invite: InvitePayload = {
        type:      'invite',
        fromId:    e.fromAddress,
        fromName,
        groupId:   'g-' + passcode,
        groupName,
        passcode,
        ts:        Date.now(),
      };
      this.pendingInvite.set({ payload: invite, peerAddress: e.fromAddress });
      setTimeout(() => {
        const cur = this.pendingInvite();
        if (cur?.payload.ts === invite.ts) this.pendingInvite.set(null);
      }, 30000);
      return;
    }

    // Response to an invite WE sent. riderId == sender's BLE MAC == sentState key.
    const riderId = e.fromAddress;
    if (kind === 'A') {
      this._setSentState(riderId, 'accepted');
      this._mesh.addPeerToGroup(riderId);
      setTimeout(() => this._clearSentState(riderId), 4000);
    } else if (kind === 'D') {
      this._setSentState(riderId, 'declined');
      setTimeout(() => this._clearSentState(riderId), 3000);
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _onInviteReceived(msg: InvitePayload, peerAddress: string): void {
    // Ignore if already in a group
    if (this._mesh.activeGroup()) return;
    this.pendingInvite.set({ payload: msg, peerAddress });

    // Auto-dismiss after 30s if not acted on
    setTimeout(() => {
      const cur = this.pendingInvite();
      if (cur?.payload.ts === msg.ts) this.pendingInvite.set(null);
    }, 30000);
  }

  private _onResponseReceived(msg: InvitePayload): void {
    // Find which riderId this response came from
    const rider = this._mesh.nearbyRiders().find(r => r.name === msg.fromName);
    const riderId = rider?.id ?? msg.fromId;

    if (msg.accepted) {
      this._setSentState(riderId, 'accepted');
      // Add them to the group
      this._mesh.addPeerToGroup(riderId);
      setTimeout(() => this._clearSentState(riderId), 4000);
    } else {
      this._setSentState(riderId, 'declined');
      setTimeout(() => this._clearSentState(riderId), 3000);
    }
  }

  private _setSentState(riderId: string, state: 'sending' | 'sent' | 'accepted' | 'declined'): void {
    this.sentState.update(m => new Map(m).set(riderId, state));
  }

  private _clearSentState(riderId: string): void {
    this.sentState.update(m => { const n = new Map(m); n.delete(riderId); return n; });
  }

  ngOnDestroy(): void {
    this._teardown?.();
    this._bleListener?.remove();
  }
}
