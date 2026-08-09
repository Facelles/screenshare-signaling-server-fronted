import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { SERVER_URL, STUN_SERVERS, VIDEO_MAX_BITRATE, VIDEO_START_BITRATE } from '../config.js';

interface Props {
  token: string; // pre-assigned token (empty on first load — host creates room)
}

type Status = 'init' | 'waiting' | 'connected' | 'viewer_left' | 'error';

/** Prefer VP9, fallback H.264 */
function preferVP9(sdp: string): string {
  const match = sdp.match(/a=rtpmap:(\d+) VP9/);
  if (!match) return sdp;
  const pt = match[1];
  return sdp.replace(/m=video (\S+ \S+ )(.+)/, (_m, prefix, pts) => {
    const list = pts.split(' ').filter((p: string) => p !== pt);
    return `m=video ${prefix}${pt} ${list.join(' ')}`;
  });
}

async function applyBitrate(pc: RTCPeerConnection, start: number, max: number): Promise<void> {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = max;
  params.encodings[0].maxFramerate = 60;
  (params.encodings[0] as Record<string, unknown>)['startBitrate'] = start;
  await sender.setParameters(params);
}

export default function Host(_props: Props) {
  const videoRef   = useRef<HTMLVideoElement>(null);
  const pcRef      = useRef<RTCPeerConnection | null>(null);
  const socketRef  = useRef<Socket | null>(null);
  const streamRef  = useRef<MediaStream | null>(null);

  const [status, setStatus]     = useState<Status>('init');
  const [sharing, setSharing]   = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [copied, setCopied]     = useState(false);
  const [error, setError]       = useState('');
  const [fps, setFps]           = useState(0);
  const [kbps, setKbps]         = useState(0);

  // ── Stats polling ──────────────────────────────────────────────────────
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
    pcRef.current?.close();
    streamRef.current = null;
    pcRef.current = null;
    setSharing(false);
    setStatus('waiting');
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // ── Connect socket & create room on mount ──────────────────────────────
  useEffect(() => {
    const socket: Socket = io(SERVER_URL, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      // Always create a fresh room when host page loads
      socket.emit('create_room');
    });

    socket.on('room_created', ({ token }: { roomId: string; token: string }) => {
      const link = `${window.location.origin}/?page=viewer&token=${token}`;
      setShareLink(link);
      setStatus('waiting');
    });

    socket.on('viewer_joined', async () => {
      if (!pcRef.current) {
        // Viewer joined before screen share started — create PC when share starts
        setStatus('connected');
        return;
      }
      await startOffer(socket);
    });

    socket.on('answer', async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      await pcRef.current?.setRemoteDescription(sdp);
      await applyBitrate(pcRef.current!, VIDEO_START_BITRATE, VIDEO_MAX_BITRATE);
    });

    socket.on('ice_candidate', async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      await pcRef.current?.addIceCandidate(candidate);
    });

    socket.on('viewer_left', () => setStatus('viewer_left'));

    socket.on('connect_error', () => {
      setError('Не вдалося підключитися до сигнального сервера.');
      setStatus('error');
    });

    return () => {
      socket.disconnect();
      stopSharing();
    };
  }, [stopSharing]);

  async function startOffer(socket: Socket): Promise<void> {
    if (!streamRef.current) return;

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    pcRef.current = pc;

    streamRef.current.getTracks().forEach((t) =>
      pc.addTrack(t, streamRef.current!),
    );

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('ice_candidate', { candidate });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setStatus('viewer_left');
      }
    };

    const offer = await pc.createOffer();
    const sdp = preferVP9(offer.sdp ?? '');
    await pc.setLocalDescription({ type: 'offer', sdp });
    socket.emit('offer', { sdp: pc.localDescription });
  }

  const handleStartShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        audio: true,
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
      }

      stream.getVideoTracks()[0].onended = stopSharing;
      setSharing(true);

      // If viewer already joined before share started
      if (status === 'connected') {
        await startOffer(socketRef.current!);
      }
    } catch (err) {
      if ((err as { name?: string }).name !== 'NotAllowedError') {
        setError('Не вдалося захопити екран.');
      }
    }
  }, [status, stopSharing]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(shareLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [shareLink]);

  const statusConfig = {
    init:        { label: 'Підключення...',       dot: 'bg-white/30',    text: 'text-white/40' },
    waiting:     { label: 'Очікування глядача',   dot: 'bg-amber-400',   text: 'text-amber-400' },
    connected:   { label: 'Глядач підключений',   dot: 'bg-emerald-400', text: 'text-emerald-400' },
    viewer_left: { label: 'Глядач відключився',   dot: 'bg-white/40',    text: 'text-white/40' },
    error:       { label: 'Помилка',               dot: 'bg-red-400',     text: 'text-red-400' },
  } as const;

  const sc = statusConfig[status];

  return (
    <div className="relative z-10 min-h-screen flex flex-col items-center justify-center p-6 gap-5">
      <div className="glass rounded-2xl p-8 w-full max-w-xl page-enter space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">🖥 Трансляція хоста</h2>
          <span className={`flex items-center gap-1.5 text-xs font-medium ${sc.text}`}>
            <span className={`w-2 h-2 rounded-full ${sc.dot} pulse-dot`} />
            {sc.label}
          </span>
        </div>

        {/* Share link — shown immediately after room is created */}
        {shareLink && (
          <div className="space-y-1.5">
            <p className="text-xs uppercase tracking-widest text-white/30 font-medium">
              Посилання для глядача
            </p>
            <div className="flex items-center gap-2 px-3 py-2.5
              bg-violet-500/10 border border-violet-500/30 rounded-lg">
              <span className="flex-1 text-violet-300 text-xs font-mono truncate">
                {shareLink}
              </span>
              <button
                onClick={handleCopy}
                className="p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60
                  hover:text-white transition-colors cursor-pointer"
              >
                {copied
                  ? <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
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
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
              <span className="text-sm">Натисни «Поділитися екраном»</span>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          {!sharing ? (
            <button
              onClick={handleStartShare}
              disabled={status === 'init'}
              className="py-2.5 px-5 rounded-lg bg-gradient-to-r from-violet-600 to-purple-500
                text-white font-semibold text-sm cursor-pointer
                hover:shadow-[0_0_24px_4px_rgba(124,58,237,0.4)] hover:-translate-y-px
                active:scale-[.97] transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ▶ Поділитися екраном
            </button>
          ) : (
            <button
              onClick={stopSharing}
              className="py-2.5 px-5 rounded-lg bg-red-600/80 border border-red-500/40
                text-white font-semibold text-sm cursor-pointer
                hover:bg-red-600 transition-all duration-200 active:scale-[.97]"
            >
              ■ Зупинити
            </button>
          )}
        </div>

        {/* Stats */}
        {status === 'connected' && (
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'FPS',     value: fps  ? `${fps}` : '—' },
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
            <a href="https://existential.audio/blackhole/" target="_blank" rel="noopener noreferrer" className="underline">
              BlackHole
            </a>.
          </div>
        )}

        {error && (
          <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/25 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
