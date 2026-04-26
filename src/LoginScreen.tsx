import React, { useState } from 'react';
import { LogIn, Eye, EyeOff, AlertCircle } from 'lucide-react';

interface LoginScreenProps {
  onLogin: (userName: string) => void;
}

const USERS = [
  { name: 'Sageer A. Shaikh', firstName: 'sageer', role: 'Lead Research & Qualification' },
  { name: 'Ahmad Khan', firstName: 'ahmad', role: 'Sales Representative' },
  { name: 'Dr. Jochen Langguth', firstName: 'jochen', role: 'Managing Director' },
  { name: 'Dr. Juergen Schellenberger', firstName: 'juergen', role: 'Technical Director' },
  { name: 'Christoph Langguth', firstName: 'christoph', role: 'Business Development' },
  { name: 'Patton Lucas', firstName: 'patton', role: 'Sales Manager' },
  { name: 'Dr. Kathrin Langguth', firstName: 'kathrin', role: 'Operations' },
];

export default function LoginScreen({ onLogin }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    setTimeout(() => {
      const user = USERS.find(u =>
        u.firstName.toLowerCase() === username.toLowerCase().trim() ||
        u.name.toLowerCase() === username.toLowerCase().trim()
      );

      if (!user) {
        setError('User not found. Use your first name to log in.');
        setLoading(false);
        return;
      }

      const expectedPassword = `${user.firstName.toLowerCase()}@135`;
      if (password !== expectedPassword) {
        setError('Invalid password. Hint: firstname@135');
        setLoading(false);
        return;
      }

      localStorage.setItem('sinteriq_user', JSON.stringify({ name: user.name, role: user.role, loginAt: new Date().toISOString() }));
      onLogin(user.name);
      setLoading(false);
    }, 500);
  };

  return (
    <div className="sinter-login min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="sinter-official-logo-panel rounded-lg p-3 mb-5">
            <img
              src="/branding/sintertechnik-logo.png"
              alt="Sintertechnik GmbH HiTech Solutions"
              className="sinter-official-logo"
            />
          </div>
          <div className="inline-flex items-center justify-center gap-3">
            <div className="sinter-brand-mark w-10 h-10 rounded flex items-center justify-center">
              <img src="/branding/sintertechnik-mark-192.jpg" alt="" className="sinter-mark-image" />
            </div>
            <div className="text-left">
              <h1 className="text-3xl font-bold text-white tracking-tight leading-none">SinterIQ</h1>
              <p className="text-slate-400 text-sm mt-1">Lead Intelligence</p>
            </div>
          </div>
        </div>

        {/* Login form */}
        <div className="sinter-card rounded-lg p-8">
          <h2 className="text-xl font-semibold text-slate-900 mb-1">Welcome back</h2>
          <p className="text-sm text-slate-500 mb-6">Sign in to your team account</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={e => { setUsername(e.target.value); setError(''); }}
                placeholder="Enter your first name"
                autoFocus
                required
                className="sinter-input w-full px-4 py-2.5 rounded-md text-sm outline-none transition-all"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError(''); }}
                  placeholder="Enter your password"
                  required
                  className="sinter-input w-full px-4 py-2.5 pr-10 rounded-md text-sm outline-none transition-all"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="sinter-button-primary w-full flex items-center justify-center gap-2 text-white py-2.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <><LogIn className="w-4 h-4" /> Sign In</>
              )}
            </button>
          </form>

          {/* Team members hint */}
          <div className="mt-6 pt-6 border-t border-slate-100">
            <p className="text-xs text-slate-400 mb-3 text-center">Team Members</p>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {USERS.map(u => (
                <button
                  key={u.firstName}
                  onClick={() => { setUsername(u.firstName); setPassword(`${u.firstName.toLowerCase()}@135`); setError(''); }}
                  className="text-xs bg-slate-100 hover:bg-blue-100 hover:text-blue-700 text-slate-600 px-2.5 py-1 rounded-full transition-colors"
                >
                  {u.name.split(' ')[0]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-slate-500 mt-6">
          Sintertechnik GmbH · SinterIQ v1.0
        </p>
      </div>
    </div>
  );
}
