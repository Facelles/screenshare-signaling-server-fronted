export const SERVER_URL =
  (import.meta as { env: { VITE_SERVER_URL?: string } }).env.VITE_SERVER_URL ??
  'http://localhost:3001';

export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/** Target start bitrate for video sender (bits/s) */
export const VIDEO_START_BITRATE = 4_000_000;   // 4 Mbps
export const VIDEO_MAX_BITRATE   = 8_000_000;   // 8 Mbps
