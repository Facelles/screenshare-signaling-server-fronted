import { useCallback, useState, useEffect } from 'react';
import { navigate } from '../App.js';
import { ACCESS_PASSWORD } from '../config.js';

export default function Home() {
  const [tokenInput, setTokenInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [joinError, setJoinError] = useState('');
  const [tab, setTab] = useState<'host' | 'join'>('host');

  // Load saved password from session storage if not in env
  useEffect(() => {
    if (!ACCESS_PASSWORD) {
      const saved = sessionStorage.getItem('app_password');
      if (saved) setPasswordInput(saved);
    }
  }, []);

  const handleSavePassword = (pwd: string) => {
    setPasswordInput(pwd);
    sessionStorage.setItem('app_password', pwd);
  };

  const handleGoHost = useCallback(() => {
    if (!ACCESS_PASSWORD && !passwordInput.trim()) {
      setJoinError('Введіть пароль доступу.');
      return;
    }
    navigate('/?page=host');
  }, [passwordInput]);

  const handleJoin = useCallback(() => {
    setJoinError('');
    if (!ACCESS_PASSWORD && !passwordInput.trim()) {
      setJoinError('Введіть пароль доступу.');
      return;
    }

    const raw = tokenInput.trim();
    if (!raw) {
      setJoinError('Вставте посилання або токен.');
      return;
    }

    let token = raw;
    try {
      const url = new URL(raw);
      token = url.searchParams.get('token') ?? raw;
    } catch { /* bare token */ }

    if (!token) {
      setJoinError('Вставте посилання або токен.');
      return;
    }

    navigate(`/?page=viewer&token=${token}`);
  }, [tokenInput, passwordInput]);

  return (
    <div className="relative z-10 min-h-screen flex flex-col items-center justify-center p-6">

      {/* Logo */}
      <div className="flex items-center gap-2 mb-10 text-white/90 font-semibold text-base tracking-tight">
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
        Screen<span className="text-purple-400">Share</span>
      </div>

      {/* Card */}
      <div className="glass rounded-2xl p-8 w-full max-w-md page-enter">
        <h1 className="text-2xl font-bold tracking-tight mb-1">Приватна трансляція</h1>
        <p className="text-sm text-white/50 mb-6">P2P · WebRTC · Зашифровано · &lt;150 мс</p>

        {/* Global Password (if not in env) */}
        {!ACCESS_PASSWORD && (
          <div className="mb-6 bg-white/5 p-4 rounded-xl border border-white/10">
            <label className="block text-xs font-medium text-white/40 uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
              Пароль доступу до сервера
            </label>
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => handleSavePassword(e.target.value)}
              placeholder="Введіть пароль"
              className="w-full px-3.5 py-2 bg-white/4 border border-white/10 rounded-lg
                text-sm text-white placeholder-white/20 outline-none
                focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30 transition-all"
            />
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 bg-white/5 rounded-lg p-1 mb-7 border border-white/5">
          {(['host', 'join'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-all duration-200 cursor-pointer
                ${tab === t
                  ? 'bg-gradient-to-br from-violet-600 to-purple-500 text-white shadow-lg shadow-violet-900/40'
                  : 'text-white/50 hover:text-white/80 hover:bg-white/5'}`}
            >
              {t === 'host' ? '🖥 Транслювати' : '👁 Переглянути'}
            </button>
          ))}
        </div>

        {/* HOST PANEL */}
        {tab === 'host' && (
          <div className="space-y-4">
            <p className="text-sm text-white/50">
              Натисни — відкриється сторінка трансляції, де отримаєш посилання для глядача.
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
          </div>
        )}

        {joinError && (
          <div className="mt-4 px-3 py-2.5 bg-red-500/10 border border-red-500/25 rounded-lg text-red-400 text-sm">
            {joinError}
          </div>
        )}
      </div>

      <p className="mt-6 text-xs text-white/20 text-center">
        WebRTC P2P — сервер бачить лише сигналінг, не відео
      </p>
    </div>
  );
}
