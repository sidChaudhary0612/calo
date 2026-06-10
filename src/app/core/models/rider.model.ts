export type RiderStatus = 'online' | 'away' | 'offline';
export type RiderRole   = 'leader' | 'member' | 'solo';

export interface Rider {
  id:        string;
  name:      string;
  avatarInitials: string;
  status:    RiderStatus;
  role:      RiderRole;
  location?: RiderLocation;
  distance?: number;   // meters
  speed?:    number;   // km/h
  bearing?:  number;   // degrees
  battery?:     number;   // 0-100
  signal?:      number;   // 0-100 (mesh signal strength)
  signalAngle?: number;   // 0-359 degrees — stable per-peer angle for radar blip
  lastSeen?:    Date;
}

export interface RiderLocation {
  lat:       number;
  lng:       number;
  altitude?: number;
  accuracy?: number;
  timestamp: number;
}

export interface RideGroup {
  id:         string;
  name:       string;
  leaderId:   string;
  memberIds:  string[];
  createdAt:  Date;
  route?:     GroupRoute;
  status:     'forming' | 'riding' | 'paused' | 'ended';
  passcode?:  string;
}

export interface GroupRoute {
  id:          string;
  name:        string;
  waypoints:   RiderLocation[];
  totalKm:     number;
  estimatedMin: number;
}
