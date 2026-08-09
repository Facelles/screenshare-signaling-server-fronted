import { useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { navigate } from '../App.js';
import { SERVER_URL } from '../config.js';

type Tab = 'host' | 'join';

function CopyIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>('host');

  // ── HOST state ──────────────────────────────────────────────────────────
  const [creating, setCreating] = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [createdRoom, setCreatedRoom] = useState<{ roomId: string; token: string } | null>(null);
  const [createError, setCreateError] = useState('');
  const [copied, setCopied] = useState(false);

  // ── VIEWER state ────────────────────────────────────────────────────────
  const [tokenInput, setTokenInput] = useState('');
  const [joinError, setJoinError] = useState('');

  const handleCreateRoom = useCallback(() => {
    setCreating(true);
    setCreateError('');

    const socket: Socket = io(SERVER_URL, { transports: ['websocket'] });

    socket.on('connect', () => socket.emit('create_room'));

    socket.on('room_created', ({ roomId, token }: { roomId: string; token: string }) => {
      const url = `${window.location.origin}/?page=viewer&token=${token}`;
      setShareLink(url);
      setCreatedRoom({ roomId, token });
      setCreating(false);
      socket.disconnect(); // host page will open its own socket
    });

    socket.on('connect_error', () => {
      setCreateError('Не вдалося підключитись до сервера. Перевірте, чи запущений backend.');
      setCreating(false);
    });
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(shareLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [shareLink]);

  const handleGoHost = useCallback(() => {
    if (!createdRoom) return;
    navigate(`/?page=host&room=${createdRoom.roomId}&token=${createdRoom.token}`);
  }, [createdRoom]);

  const handleJoin = useCallback(() => {
    setJoinError('');
    const raw = tokenInput.trim();
    if (!raw) return;

    let token = raw;
    try {
      const url = new URL(raw);
      token = url.searchParams.get('token') ?? raw;
    } catch { /* bare token */ }

    navigate(`/?page=viewer&token=${token}`);
  }, [tokenInput]);

  return (
    <div className="relative z-10 min-h-screen flex flex-col items-center justify-center p-6">

      {/* Logo */}
      <div className="flex items-center gap-2 mb-10 text-white/90 font-semibold text-base tracking-tight">
        <MonitorIcon />
        Screen<span className="text-purple-400">Share</span>
      </div>

      {/* Card */}
      <div className="glass rounded-2xl p-8 w-full max-w-md page-enter">

        <h1 className="text-2xl font-bold tracking-tight mb-1">Приватна трансляція</h1>
        <p className="text-sm text-white/50 mb-6">P2P · WebRTC · Зашифровано · &lt;150 мс</p>

        {/* Tabs */}
        <div className="flex gap-1 bg-white/5 rounded-lg p-1 mb-7">
          {(['host', 'join'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-all duration-200 cursor-pointer
                ${tab === t
                  ? 'bg-violet-600 text-white shadow-lg shadow-violet-900/40'
                  : 'text-white/50 hover:text-white/80'}`}
            >
              {t === 'host' ? '🖥 Транслювати' : '👁 Переглянути'}
            </button>
          ))}
        </div>

        {/* HOST PANEL */}
        {tab === 'host' && (
          <div className="space-y-4">
            <p className="text-sm text-white/50">
              Натисни — отримаєш одноразове посилання для глядача.
            </p>

            {!createdRoom ? (
              <button
                onClick={handleCreateRoom}
                disabled={creating}
                className="w-full py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-purple-500
                  text-white font-semibold text-sm cursor-pointer
                  hover:shadow-[0_0_24px_4px_rgba(124,58,237,0.4)] hover:-translate-y-px
                  active:scale-[.97] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? 'Підключення...' : 'Створити кімнату'}
              </button>
            ) : (
              <div className="space-y-3">
                {/* Link box */}
                <div className="flex items-center gap-2 px-3 py-2.5
                  bg-violet-500/10 border border-violet-500/30 rounded-lg">
                  <span className="flex-1 text-violet-300 text-xs font-mono truncate">
                    {shareLink}
                  </span>
                  <button
                    onClick={handleCopy}
                    title="Скопіювати"
                    className="p-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60
                      hover:text-white transition-colors cursor-pointer"
                  >
                    {copied ? (
                      <svg className="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : <CopyIcon />}
                  </button>
                </div>
                <p className="text-xs text-white/30">
                  Посилання дійсне до закриття вкладки.
                </p>
                <button
                  onClick={handleGoHost}
                  className="w-full py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-purple-500
                    text-white font-semibold text-sm cursor-pointer
                    hover:shadow-[0_0_24px_4px_rgba(124,58,237,0.4)] hover:-translate-y-px
                    active:scale-[.97] transition-all duration-200"
                >
                  Відкрити трансляцію →
                </button>
              </div>
            )}

            {createError && (
              <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/25 rounded-lg text-red-400 text-sm">
                {createError}
              </div>
            )}
          </div>
        )}

        {/* VIEWER PANEL */}
        {tab === 'join' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-white/40 uppercase tracking-widest mb-1.5">
                Посилання або токен
              </label>
              <input
                type="text"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                placeholder="https://... або вставте токен"
                autoComplete="off"
                spellCheck={false}
                className="w-full px-3.5 py-2.5 bg-white/4 border border-white/10 rounded-lg
                  text-sm text-white placeholder-white/20 outline-none
                  focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30 transition-all"
              />
            </div>
            <button
              onClick={handleJoin}
              className="w-full py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-purple-500
                text-white font-semibold text-sm cursor-pointer
                hover:shadow-[0_0_24px_4px_rgba(124,58,237,0.4)] hover:-translate-y-px
                active:scale-[.97] transition-all duration-200"
            >
              Підключитись
            </button>
            {joinError && (
              <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/25 rounded-lg text-red-400 text-sm">
                {joinError}
              </div>
            )}
          </div>
        )}
      </div>

      <p className="mt-6 text-xs text-white/20 text-center">
        WebRTC P2P — сервер бачить лише сигналінг, не відео
      </p>
    </div>
  );
}
