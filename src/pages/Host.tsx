import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { SERVER_URL, STUN_SERVERS, VIDEO_MAX_BITRATE, VIDEO_START_BITRATE } from '../config.js';

interface Props { token: string; }

type Status = 'init' | 'waiting' | 'connected' | 'viewer_left' | 'error';

function preferVP9(sdp: string): string {
  const match = sdp.match(/a=rtpmap:(\d+) VP9/);
  if (!match) return sdp;
  const pt = match[1];
  return sdp.replace(/m=video (\S+ \S+ )(.+)/, (_m, prefix, pts) => {
    const list = pts.split(' ').filter((p: string) => p !== pt);
    return `m=video ${prefix}${pt} ${list.join(' ')}`;
  });
}

async function applyBitrate(pc: RTCPeerConnection, start: number, max: number) {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = max;
  params.encodings[0].maxFramerate = 60;
  (params.encodings[0] as Record<string, unknown>)['startBitrate'] = start;
  await sender.setParameters(params);
}

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
};

export default function Host(_props: Props) {
  const viewerJoinedRef  = useRef(false);
  const videoRef         = useRef<HTMLVideoElement>(null);
  const viewerAudioRef   = useRef<HTMLAudioElement>(null);  // viewer's mic audio
  const pcRef            = useRef<RTCPeerConnection | null>(null);
  const socketRef        = useRef<Socket | null>(null);
  const streamRef        = useRef<MediaStream | null>(null);
  const micStreamRef     = useRef<MediaStream | null>(null);
  const micSenderRef     = useRef<RTCRtpSender | null>(null);

  const [status, setStatus]       = useState<Status>('init');
  const [sharing, setSharing]     = useState(false);
  const [micOn, setMicOn]         = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [copied, setCopied]       = useState(false);
  const [error, setError]         = useState('');
  const [fps, setFps]             = useState(0);
  const [kbps, setKbps]           = useState(0);

  // ── Stats ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'connected') return;
    let lastBytes = 0;
    const id = setInterval(async () => {
      const stats = await pcRef.current?.getStats();
      stats?.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          const bytes = (r as RTCOutboundRtpStreamStats).bytesSent ?? 0;
          const fr = (r as RTCOutboundRtpStreamStats & { framesPerSecond?: number }).framesPerSecond;
          setKbps(Math.round(((bytes - lastBytes) * 8) / 1000));
          lastBytes = bytes;
          if (fr) setFps(Math.round(fr));
        }
      });
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  const stopSharing = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    setSharing(false);
    setStatus('waiting');
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  async function startOffer(socket: Socket) {
    if (!streamRef.current) return;

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    pcRef.current = pc;

    // Add screen tracks (video + screen audio)
    streamRef.current.getTracks().forEach((t) => pc.addTrack(t, streamRef.current!));

    // Add mic track if already enabled
    if (micStreamRef.current) {
      const micTrack = micStreamRef.current.getAudioTracks()[0];
      if (micTrack) micSenderRef.current = pc.addTrack(micTrack, micStreamRef.current);
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice_candidate', { candidate });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setStatus('viewer_left');
      }
    };

    // Receive viewer's mic audio
    pc.ontrack = ({ track }) => {
      if (track.kind === 'audio' && viewerAudioRef.current) {
        const stream = new MediaStream([track]);
        viewerAudioRef.current.srcObject = stream;
        viewerAudioRef.current.play().catch(() => {});
      }
    };

    const offer = await pc.createOffer();
    const sdp = preferVP9(offer.sdp ?? '');
    await pc.setLocalDescription({ type: 'offer', sdp });
    socket.emit('offer', { sdp: pc.localDescription });
  }

  // ── Socket setup ───────────────────────────────────────────────────────
  useEffect(() => {
    const socket: Socket = io(SERVER_URL, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => socket.emit('create_room'));

    socket.on('room_created', ({ token }: { roomId: string; token: string }) => {
      setShareLink(`${window.location.origin}/?page=viewer&token=${token}`);
      setStatus('waiting');
    });

    socket.on('viewer_joined', async () => {
      viewerJoinedRef.current = true;
      setStatus('connected');
      if (streamRef.current) await startOffer(socket);
    });

    socket.on('answer', async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      await pcRef.current?.setRemoteDescription(sdp);
      await applyBitrate(pcRef.current!, VIDEO_START_BITRATE, VIDEO_MAX_BITRATE);
    });

    socket.on('ice_candidate', async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      await pcRef.current?.addIceCandidate(candidate);
    });

    // Handle viewer's mic offer (renegotiation for viewer mic)
    socket.on('viewer_offer', async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      if (!pcRef.current) return;
      await pcRef.current.setRemoteDescription(sdp);
      const answer = await pcRef.current.createAnswer();
      await pcRef.current.setLocalDescription(answer);
      socket.emit('host_answer', { sdp: pcRef.current.localDescription });
    });

    socket.on('viewer_left', () => {
      viewerJoinedRef.current = false;
      setStatus('viewer_left');
    });

    socket.on('connect_error', () => {
      setError('Не вдалося підключитися до сигнального сервера.');
      setStatus('error');
    });

    return () => { socket.disconnect(); stopSharing(); };
  }, [stopSharing]);

  // ── Screen share ───────────────────────────────────────────────────────
  const handleStartShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        audio: true,
      });
      streamRef.current = stream;

      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.muted = true; }
      stream.getVideoTracks()[0].onended = stopSharing;
      setSharing(true);

      if (viewerJoinedRef.current) await startOffer(socketRef.current!);
    } catch (err) {
      if ((err as { name?: string }).name !== 'NotAllowedError') setError('Не вдалося захопити екран.');
    }
  }, [stopSharing]);

  // ── Mic toggle ────────────────────────────────────────────────────────
  const handleToggleMic = useCallback(async () => {
    if (micOn) {
      // Disable mic
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      if (micSenderRef.current && pcRef.current) {
        pcRef.current.removeTrack(micSenderRef.current);
        micSenderRef.current = null;
      }
      setMicOn(false);
    } else {
      // Enable mic
      try {
        const micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        micStreamRef.current = micStream;
        const micTrack = micStream.getAudioTracks()[0];

        if (pcRef.current) {
          micSenderRef.current = pcRef.current.addTrack(micTrack, micStream);
          // Trigger renegotiation
          const offer = await pcRef.current.createOffer();
          await pcRef.current.setLocalDescription(offer);
          socketRef.current?.emit('offer', { sdp: pcRef.current.localDescription });
        }
        setMicOn(true);
      } catch {
        setError('Немає доступу до мікрофона.');
      }
    }
  }, [micOn]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(shareLink).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    });
  }, [shareLink]);

  const sc = {
    init:        { label: 'Підключення...',      dot: 'bg-white/30',    text: 'text-white/40' },
    waiting:     { label: 'Очікування глядача',  dot: 'bg-amber-400',   text: 'text-amber-400' },
    connected:   { label: 'Глядач підключений',  dot: 'bg-emerald-400', text: 'text-emerald-400' },
    viewer_left: { label: 'Глядач відключився',  dot: 'bg-white/40',    text: 'text-white/40' },
    error:       { label: 'Помилка',              dot: 'bg-red-400',     text: 'text-red-400' },
  }[status];

  return (
    <div className="relative z-10 min-h-screen flex flex-col items-center justify-center p-6 gap-5">
      {/* Hidden audio element for viewer's mic */}
      <audio ref={viewerAudioRef} autoPlay playsInline />

      <div className="glass rounded-2xl p-8 w-full max-w-xl page-enter space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">🖥 Трансляція хоста</h2>
          <span className={`flex items-center gap-1.5 text-xs font-medium ${sc.text}`}>
            <span className={`w-2 h-2 rounded-full ${sc.dot} pulse-dot`} />
            {sc.label}
          </span>
        </div>

        {/* Share link */}
        {shareLink && (
          <div className="space-y-1.5">
            <p className="text-xs uppercase tracking-widest text-white/30 font-medium">Посилання для глядача</p>
            <div className="flex items-center gap-2 px-3 py-2.5 bg-violet-500/10 border border-violet-500/30 rounded-lg">
              <span className="flex-1 text-violet-300 text-xs font-mono truncate">{shareLink}</span>
              <button onClick={handleCopy} className="p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer">
                {copied
                  ? <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  : <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                }
              </button>
            </div>
            <p className="text-xs text-white/25">Посилання дійсне поки ця вкладка відкрита.</p>
          </div>
        )}

        {/* Preview */}
        <div className="relative rounded-xl overflow-hidden bg-black border border-white/8 aspect-video">
          <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-contain" />
          {!sharing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/30">
              <svg className="w-10 h-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
              </svg>
              <span className="text-sm">Натисни «Поділитися екраном»</span>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          {!sharing ? (
            <button onClick={handleStartShare} disabled={status === 'init'}
              className="py-2.5 px-5 rounded-lg bg-gradient-to-r from-violet-600 to-purple-500
                text-white font-semibold text-sm cursor-pointer
                hover:shadow-[0_0_24px_4px_rgba(124,58,237,0.4)] hover:-translate-y-px
                active:scale-[.97] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed">
              ▶ Поділитися екраном
            </button>
          ) : (
            <button onClick={stopSharing}
              className="py-2.5 px-5 rounded-lg bg-red-600/80 border border-red-500/40
                text-white font-semibold text-sm cursor-pointer hover:bg-red-600 transition-all duration-200 active:scale-[.97]">
              ■ Зупинити
            </button>
          )}

          {/* Mic button — always visible when viewer connected */}
          {status === 'connected' && (
            <button onClick={handleToggleMic}
              className={`flex items-center gap-2 py-2.5 px-4 rounded-lg border text-sm font-medium cursor-pointer
                transition-all duration-200 active:scale-[.97]
                ${micOn
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30'
                  : 'bg-white/5 border-white/15 text-white/50 hover:text-white hover:border-white/30'
                }`}>
              {micOn ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
                  <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/>
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="2" y1="2" x2="22" y2="22"/>
                  <path d="M18.89 13.23A7.12 7.12 0 0019 12v-2M5 10v2a7 7 0 007 7M15 9.34V4a3 3 0 00-5.68-1.33"/>
                  <path d="M9 9v3a3 3 0 005.12 2.12M12 19v4M8 23h8"/>
                </svg>
              )}
              {micOn ? 'Мікрофон увімк.' : 'Мікрофон вимк.'}
            </button>
          )}
        </div>

        {/* Stats */}
        {status === 'connected' && (
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'FPS',     value: fps  ? `${fps}`          : '—' },
              { label: 'Бітрейт', value: kbps ? `${kbps} кбіт/с` : '—' },
            ].map(({ label, value }) => (
              <div key={label} className="bg-white/3 border border-white/8 rounded-lg p-3 text-center">
                <p className="text-xs text-white/30 uppercase tracking-widest">{label}</p>
                <p className="text-base font-semibold mt-0.5">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* BlackHole hint */}
        {sharing && (
          <div className="px-3 py-3 bg-emerald-500/8 border border-emerald-500/20 rounded-lg text-emerald-400 text-xs leading-relaxed">
            💡 <strong>Системне аудіо macOS:</strong> Chrome/Edge захоплює аудіо вкладки нативно.
            Для повного системного звуку встанови{' '}
            <a href="https://existential.audio/blackhole/" target="_blank" rel="noopener noreferrer" className="underline">BlackHole</a>.
          </div>
        )}

        {error && (
          <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/25 rounded-lg text-red-400 text-sm">{error}</div>
        )}
      </div>
    </div>
  );
}
