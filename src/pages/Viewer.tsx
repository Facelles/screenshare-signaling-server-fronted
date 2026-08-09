import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { SERVER_URL, STUN_SERVERS, ACCESS_PASSWORD } from '../config.js';
import { useAudioVolume } from '../hooks/useAudioVolume.js';

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSenderRef = useRef<RTCRtpSender | null>(null);

  const [status, setStatus] = useState<Status>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [micOn, setMicOn] = useState(false);
  const [micError, setMicError] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHud, setShowHud] = useState(false);
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fps, setFps] = useState(0);
  const [kbps, setKbps] = useState(0);
  const [latencyMs, setLatencyMs] = useState(0);

  // Audio streams for volume detection
  const [localMicStream, setLocalMicStream] = useState<MediaStream | null>(null);
  const isViewerSpeaking = useAudioVolume({ stream: localMicStream, threshold: 12 });

  const [remoteMicStream, setRemoteMicStream] = useState<MediaStream | null>(null);
  const isHostSpeaking = useAudioVolume({ stream: remoteMicStream, threshold: 12 });
  
  // Audio Ducking state
  const videoStreamIdRef = useRef<string | null>(null);
  const [remoteAudioTracks, setRemoteAudioTracks] = useState<{ track: MediaStreamTrack, streamId: string }[]>([]);
  const systemAudioRef = useRef<HTMLAudioElement>(null);
  const hostMicAudioRef = useRef<HTMLAudioElement>(null);

  const revealHud = useCallback(() => {
    setShowHud(true);
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current);
    hudTimerRef.current = setTimeout(() => setShowHud(false), 3000);
  }, []);

  // ── Audio Ducking (Приглушення звуку) ──────────────────────────────────
  useEffect(() => {
    if (systemAudioRef.current) {
      const shouldDuck = isHostSpeaking || isViewerSpeaking;
      // Smoothly adjust volume would be nice, but instant is fine for now
      systemAudioRef.current.volume = shouldDuck ? 0.15 : 1.0;
    }
  }, [isHostSpeaking, isViewerSpeaking]);

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

    const pwd = ACCESS_PASSWORD || sessionStorage.getItem('app_password');
    const socket: Socket = io(SERVER_URL, {
      transports: ['websocket'],
      auth: { password: pwd }
    });
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
      let pc = pcRef.current;
      if (!pc) {
        pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
        pcRef.current = pc;

        pc.ontrack = (event) => {
          const streamId = event.streams[0]?.id || '';
          if (event.track.kind === 'video') {
            videoStreamIdRef.current = streamId;
            const stream = new MediaStream([event.track]);
            if (videoRef.current) {
              videoRef.current.srcObject = stream;
              setStatus('playing');
            }
          } else if (event.track.kind === 'audio') {
            setRemoteAudioTracks(prev => [...prev, { track: event.track, streamId }]);
          }
        };

        pc.onicecandidate = ({ candidate }) => {
          if (candidate) socket.emit('ice_candidate', { candidate });
        };

        pc.onconnectionstatechange = () => {
          if (!pc) return;
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setStatus('host_left');
            setRemoteMicStream(null);
            setRemoteAudioTracks([]);

            // Auto-reconnect WebRTC after a short delay
            setTimeout(() => {
              if (socketRef.current?.connected) {
                console.log('Attempting auto-reconnect...');
                socketRef.current.emit('join_room', { token });
              }
            }, 2500);
          }
        };
      }

      if (!pc) return;
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { sdp: pc.localDescription });
    });

    socket.on('ice_candidate', async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      await pcRef.current?.addIceCandidate(candidate);
    });

    socket.on('host_answer', async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      await pcRef.current?.setRemoteDescription(sdp);
    });

    socket.on('host_left', () => {
      setStatus('host_left');
      setRemoteMicStream(null);
    });

    socket.on('connect_error', (err) => {
      setStatus('error');
      setErrorMsg(`Не вдалося підключитися до сигнального сервера: ${err.message}`);
    });

    return () => {
      socket.disconnect();
      pcRef.current?.close();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [token]);

  // Process incoming audio tracks to distinguish System Audio vs Host Mic
  useEffect(() => {
    const systemTrack = remoteAudioTracks.find(t => t.streamId === videoStreamIdRef.current)?.track;
    const micTrack = remoteAudioTracks.find(t => t.streamId !== videoStreamIdRef.current)?.track;

    if (systemTrack && systemAudioRef.current) {
      systemAudioRef.current.srcObject = new MediaStream([systemTrack]);
    }
    if (micTrack && hostMicAudioRef.current) {
      const micStream = new MediaStream([micTrack]);
      hostMicAudioRef.current.srcObject = micStream;
      setRemoteMicStream(micStream);
    }
  }, [remoteAudioTracks]);

  // ── Mic toggle ────────────────────────────────────────────────────────
  const handleToggleMic = useCallback(async () => {
    if (micOn) {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      setLocalMicStream(null);
      if (micSenderRef.current && pcRef.current) {
        pcRef.current.removeTrack(micSenderRef.current);
        micSenderRef.current = null;
        try {
          const offer = await pcRef.current.createOffer();
          await pcRef.current.setLocalDescription(offer);
          socketRef.current?.emit('viewer_offer', { sdp: pcRef.current.localDescription });
        } catch {}
      }
      setMicOn(false);
    } else {
      try {
        setMicError('');
        const micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        micStreamRef.current = micStream;
        setLocalMicStream(micStream);
        const micTrack = micStream.getAudioTracks()[0];

        if (pcRef.current) {
          micSenderRef.current = pcRef.current.addTrack(micTrack, micStream);
          try {
            const offer = await pcRef.current.createOffer();
            await pcRef.current.setLocalDescription(offer);
            socketRef.current?.emit('viewer_offer', { sdp: pcRef.current.localDescription });
          } catch {}
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
        <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-2 text-red-500">
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        </div>
        <h2 className="text-xl font-bold tracking-tight text-white">Помилка підключення</h2>
        <p className="text-sm text-white/50">{errorMsg}</p>
        <button onClick={() => { window.location.href = '/'; }}
          className="mt-4 w-full py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-all cursor-pointer">
          На головну
        </button>
      </div>
    </div>
  );

  if (status === 'host_left') return (
    <div className="min-h-screen flex items-center justify-center bg-[#09090f] p-6">
      <div className="glass rounded-2xl p-8 max-w-sm text-center space-y-4 page-enter">
        <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-2 text-white/50">
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
        </div>
        <h2 className="text-xl font-bold tracking-tight text-white">Трансляцію завершено</h2>
        <p className="text-sm text-white/50">Хост закрив трансляцію або зник зв'язок.</p>
        <button onClick={() => { window.location.href = '/'; }}
          className="mt-4 w-full py-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-all cursor-pointer">
          На головну
        </button>
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className="relative w-full h-screen bg-black overflow-hidden group"
      onMouseMove={revealHud} onClick={revealHud} onTouchStart={revealHud}>

      {/* Audio tags for separate streams to apply ducking */}
      <audio ref={systemAudioRef} autoPlay playsInline />
      <audio ref={hostMicAudioRef} autoPlay playsInline />

      <video ref={videoRef} id="viewer-video" autoPlay playsInline className="w-full h-full object-contain" />

      {(status === 'connecting' || status === 'waiting_offer') && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/80 backdrop-blur-md z-10 text-white/60">
          <div className="spinner" />
          <p className="text-sm font-medium tracking-wide">
            {status === 'connecting' ? 'Підключення до сервера...' : 'Очікування трансляції від хоста...'}
          </p>
        </div>
      )}

      {/* Top Bar: Stats & Avatars */}
      <div className={`absolute top-0 left-0 right-0 flex items-start justify-between px-4 sm:px-6 py-4
        bg-gradient-to-b from-black/70 to-transparent pointer-events-none
        transition-opacity duration-500 z-20 ${showHud || status !== 'playing' ? 'opacity-100' : 'opacity-0'}`}>

        {/* Top Left: Stats */}
        <div className="flex flex-col gap-2 pointer-events-auto">
          {status === 'playing' && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full w-fit">
              <span className="w-2 h-2 rounded-full bg-emerald-400 pulse-dot" />
              <span className="text-[10px] uppercase tracking-wider text-emerald-400 font-bold">Live</span>
            </div>
          )}
          {status === 'playing' && (
            <div className="flex gap-3 text-[11px] text-white/60 font-mono bg-black/40 px-3 py-1.5 rounded-xl border border-white/5 backdrop-blur-sm">
              <span>{fps ? `${fps} fps` : '—'}</span>
              <span>{kbps ? `${kbps} kbps` : '—'}</span>
              {latencyMs > 0 && <span className="hidden sm:inline">{latencyMs}ms ping</span>}
            </div>
          )}
        </div>

        {/* Top Right: Avatars */}
        {status === 'playing' && (
          <div className="flex flex-col gap-2 pointer-events-auto">
            {remoteMicStream && (
              <div className="flex items-center justify-end gap-2 bg-black/40 backdrop-blur-md pl-2 pr-3 py-1.5 rounded-full border border-white/5 shadow-lg">
                <span className="text-xs font-medium text-white/80">Хост</span>
                <div className={`w-7 h-7 rounded-full bg-violet-600 flex items-center justify-center avatar-base border-2 ${isHostSpeaking ? 'avatar-speaking' : 'border-transparent'}`}>
                  <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                </div>
              </div>
            )}
            {micOn && (
              <div className="flex items-center justify-end gap-2 bg-black/40 backdrop-blur-md pl-2 pr-3 py-1.5 rounded-full border border-white/5 shadow-lg">
                <span className="text-xs font-medium text-white/80">Ви</span>
                <div className={`w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center avatar-base border-2 ${isViewerSpeaking ? 'avatar-speaking' : 'border-transparent'}`}>
                  <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" /></svg>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Control Bar (Prominent & Mobile Friendly) */}
      {status === 'playing' && (
        <div className={`absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 sm:gap-4 px-4 sm:px-6 py-3
          bg-black/60 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl z-30
          transition-all duration-500 ${showHud ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>

          <button onClick={handleToggleMic}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-all shadow-md active:scale-95
              ${micOn
                ? 'bg-emerald-500 text-white shadow-emerald-500/20 hover:bg-emerald-400'
                : 'bg-white/10 text-white hover:bg-white/20'}`}>
            {micOn ? (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" /><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8" /></svg>
            ) : (
              <svg className="w-5 h-5 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="2" y1="2" x2="22" y2="22" /><path d="M18.89 13.23A7.12 7.12 0 0019 12v-2M5 10v2a7 7 0 007 7M15 9.34V4a3 3 0 00-5.68-1.33" /><path d="M9 9v3a3 3 0 005.12 2.12M12 19v4M8 23h8" /></svg>
            )}
            <span>{micOn ? 'Мікрофон' : 'Увімкнути'}</span>
          </button>

          <div className="w-px h-8 bg-white/10 mx-1"></div>

          {'pictureInPictureEnabled' in document && (
            <button onClick={togglePip} title="Picture-in-Picture"
              className="p-3 rounded-xl bg-white/5 hover:bg-white/15 text-white/80 hover:text-white transition-all cursor-pointer active:scale-95">
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="4" width="20" height="16" rx="2" /><rect x="12" y="11" width="9" height="7" rx="1.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}

          <button onClick={toggleFullscreen} title="На весь екран"
            className="p-3 rounded-xl bg-white/5 hover:bg-white/15 text-white/80 hover:text-white transition-all cursor-pointer active:scale-95">
            {isFullscreen
              ? <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" /></svg>
              : <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6m0 0v6m0-6l-7 7M9 21H3m0 0v-6m0 6l7-7" /></svg>
            }
          </button>
        </div>
      )}

      {micError && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-30
          px-4 py-2.5 bg-red-500/20 backdrop-blur-md border border-red-500/40 rounded-xl text-red-200 text-sm shadow-xl flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          {micError}
        </div>
      )}
    </div>
  );
}
