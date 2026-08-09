import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { SERVER_URL, STUN_SERVERS } from '../config.js';

interface Props { token: string; }

type Status = 'connecting' | 'waiting_offer' | 'playing' | 'host_left' | 'error';

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
};

export default function Viewer({ token }: Props) {
  const videoRef       = useRef<HTMLVideoElement>(null);
  const hostAudioRef   = useRef<HTMLAudioElement>(null);  // host mic (separate from screen audio)
  const containerRef   = useRef<HTMLDivElement>(null);
  const pcRef          = useRef<RTCPeerConnection | null>(null);
  const socketRef      = useRef<Socket | null>(null);
  const micStreamRef   = useRef<MediaStream | null>(null);
  const micSenderRef   = useRef<RTCRtpSender | null>(null);

  const [status, setStatus]       = useState<Status>('connecting');
  const [errorMsg, setErrorMsg]   = useState('');
  const [micOn, setMicOn]         = useState(false);
  const [micError, setMicError]   = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHud, setShowHud]     = useState(false);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fps, setFps]             = useState(0);
  const [kbps, setKbps]           = useState(0);
  const [latencyMs, setLatencyMs] = useState(0);

  const revealHud = useCallback(() => {
    setShowHud(true);
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    hudTimerRef.current = setTimeout(() => setShowHud(false), 3000);
  }, []);

  // ── Stats ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'playing') return;
    let lastBytes = 0;
    const id = setInterval(async () => {
      const stats = await pcRef.current?.getStats();
      stats?.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          const bytes = (r as RTCInboundRtpStreamStats).bytesReceived ?? 0;
          const fr = (r as RTCInboundRtpStreamStats & { framesPerSecond?: number }).framesPerSecond;
          setKbps(Math.round(((bytes - lastBytes) * 8) / 1000));
          lastBytes = bytes;
          if (fr) setFps(Math.round(fr));
        }
        if (r.type === 'candidate-pair' && (r as RTCIceCandidatePairStats).state === 'succeeded') {
          const rtt = (r as RTCIceCandidatePairStats).currentRoundTripTime;
          if (rtt != null) setLatencyMs(Math.round(rtt * 1000));
        }
      });
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  // ── Socket + WebRTC ────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrorMsg('Токен не знайдений. Перевірте посилання.');
      return;
    }

    const socket: Socket = io(SERVER_URL, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join_room', { token });
      setStatus('waiting_offer');
    });

    socket.on('join_error', ({ message }: { message: string }) => {
      setStatus('error');
      setErrorMsg(message);
    });

    socket.on('offer', async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      pcRef.current = pc;

      pc.ontrack = ({ track, streams }) => {
        if (track.kind === 'video') {
          // Main screen video (with screen audio)
          if (videoRef.current && streams[0]) {
            videoRef.current.srcObject = streams[0];
            setStatus('playing');
          }
        } else if (track.kind === 'audio') {
          // Check: is this a separate mic track (not part of screen stream)?
          // We play it through the dedicated host audio element for clarity
          if (hostAudioRef.current) {
            const existing = hostAudioRef.current.srcObject as MediaStream | null;
            if (existing) {
              existing.addTrack(track);
            } else {
              hostAudioRef.current.srcObject = new MediaStream([track]);
              hostAudioRef.current.play().catch(() => {});
            }
          }
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit('ice_candidate', { candidate });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setStatus('host_left');
        }
      };

      // Handle renegotiation from host (e.g., host added mic later)
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('viewer_offer', { sdp: pc.localDescription });
        } catch { /* ignore */ }
      };

      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { sdp: pc.localDescription });
    });

    socket.on('ice_candidate', async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      await pcRef.current?.addIceCandidate(candidate);
    });

    // Host re-answered after mic renegotiation
    socket.on('host_answer', async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      await pcRef.current?.setRemoteDescription(sdp);
    });

    socket.on('host_left', () => setStatus('host_left'));

    socket.on('connect_error', () => {
      setStatus('error');
      setErrorMsg('Не вдалося підключитися до сигнального сервера.');
    });

    return () => {
      socket.disconnect();
      pcRef.current?.close();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [token]);

  // ── Mic toggle ────────────────────────────────────────────────────────
  const handleToggleMic = useCallback(async () => {
    if (micOn) {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      if (micSenderRef.current && pcRef.current) {
        pcRef.current.removeTrack(micSenderRef.current);
        micSenderRef.current = null;
      }
      setMicOn(false);
    } else {
      try {
        setMicError('');
        const micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        micStreamRef.current = micStream;
        const micTrack = micStream.getAudioTracks()[0];

        if (pcRef.current) {
          micSenderRef.current = pcRef.current.addTrack(micTrack, micStream);
          // Trigger renegotiation → onnegotiationneeded fires → viewer_offer sent
        }
        setMicOn(true);
      } catch {
        setMicError('Немає доступу до мікрофона.');
      }
    }
  }, [micOn]);

  // ── Fullscreen ─────────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      await containerRef.current.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  }, []);

  useEffect(() => {
    const fn = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', fn);
    return () => document.removeEventListener('fullscreenchange', fn);
  }, []);

  const togglePip = useCallback(async () => {
    if (!videoRef.current) return;
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await videoRef.current.requestPictureInPicture();
  }, []);

  // ── Error / disconnect overlays ────────────────────────────────────────
  if (status === 'error') return (
    <div className="min-h-screen flex items-center justify-center bg-[#09090f] p-6">
      <div className="glass rounded-2xl p-8 max-w-sm text-center space-y-4 page-enter">
        <div className="text-4xl">⛔</div>
        <h2 className="text-lg font-semibold">Помилка підключення</h2>
        <p className="text-sm text-white/50">{errorMsg}</p>
        <button onClick={() => { window.location.href = '/'; }}
          className="py-2.5 px-6 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500 transition-colors cursor-pointer">
          На головну
        </button>
      </div>
    </div>
  );

  if (status === 'host_left') return (
    <div className="min-h-screen flex items-center justify-center bg-[#09090f] p-6">
      <div className="glass rounded-2xl p-8 max-w-sm text-center space-y-4 page-enter">
        <div className="text-4xl">📴</div>
        <h2 className="text-lg font-semibold">Трансляцію завершено</h2>
        <p className="text-sm text-white/50">Хост закрив трансляцію.</p>
        <button onClick={() => { window.location.href = '/'; }}
          className="py-2.5 px-6 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500 transition-colors cursor-pointer">
          На головну
        </button>
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className="relative w-full h-screen bg-black overflow-hidden"
      onMouseMove={revealHud} onClick={revealHud}>

      {/* Hidden host mic audio (separate from screen audio in video element) */}
      <audio ref={hostAudioRef} autoPlay playsInline />

      {/* Main video (screen + screen audio) */}
      <video ref={videoRef} id="viewer-video" autoPlay playsInline className="w-full h-full object-contain" />

      {/* Waiting overlay */}
      {(status === 'connecting' || status === 'waiting_offer') && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#09090f] text-white/50">
          <div className="spinner" />
          <p className="text-sm">
            {status === 'connecting' ? 'Підключення до сервера...' : 'Очікування трансляції від хоста...'}
          </p>
        </div>
      )}

      {/* HUD */}
      <div className={`absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3
        bg-gradient-to-b from-black/70 to-transparent
        transition-opacity duration-400 ${showHud || status !== 'playing' ? 'opacity-100' : 'opacity-0'}`}>

        {/* Left: LIVE */}
        <div className="flex items-center gap-2">
          {status === 'playing' && (
            <>
              <span className="w-2 h-2 rounded-full bg-emerald-400 pulse-dot" />
              <span className="text-xs text-white/70 font-medium">LIVE</span>
            </>
          )}
        </div>

        {/* Center: stats */}
        {status === 'playing' && (
          <div className="flex gap-4 text-xs text-white/50 font-mono">
            <span>{fps ? `${fps} fps` : '—'}</span>
            <span>{kbps ? `${kbps} кбіт/с` : '—'}</span>
            {latencyMs > 0 && <span>{latencyMs} мс RTT</span>}
          </div>
        )}

        {/* Right: controls */}
        {status === 'playing' && (
          <div className="flex items-center gap-2">

            {/* Mic button */}
            <button onClick={handleToggleMic} title={micOn ? 'Вимкнути мік' : 'Увімкнути мік'}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-all
                ${micOn
                  ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/50'
                  : 'bg-white/10 text-white/60 hover:text-white border border-white/10'}`}>
              {micOn ? (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
                  <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/>
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="2" y1="2" x2="22" y2="22"/>
                  <path d="M18.89 13.23A7.12 7.12 0 0019 12v-2M5 10v2a7 7 0 007 7M15 9.34V4a3 3 0 00-5.68-1.33"/><path d="M9 9v3a3 3 0 005.12 2.12M12 19v4M8 23h8"/>
                </svg>
              )}
              {micOn ? 'Мік увімк.' : 'Мік вимк.'}
            </button>

            {/* PiP */}
            {'pictureInPictureEnabled' in document && (
              <button onClick={togglePip} title="Picture-in-Picture"
                className="p-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-colors cursor-pointer">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="4" width="20" height="16" rx="2"/>
                  <rect x="12" y="11" width="9" height="7" rx="1.5" fill="currentColor" stroke="none"/>
                </svg>
              </button>
            )}

            {/* Fullscreen */}
            <button onClick={toggleFullscreen} title="На весь екран"
              className="p-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-colors cursor-pointer">
              {isFullscreen
                ? <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>
                : <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6m0 0v6m0-6l-7 7M9 21H3m0 0v-6m0 6l7-7"/></svg>
              }
            </button>
          </div>
        )}
      </div>

      {/* Mic error toast */}
      {micError && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2
          px-4 py-2 bg-red-500/20 border border-red-500/40 rounded-lg text-red-400 text-sm">
          {micError}
        </div>
      )}
    </div>
  );
}
