'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, setToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState('');

  const onSubmit = async (event) => {
    event.preventDefault();
    setError('');
    try {
      const payload = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setToken(payload.access_token);
      router.push('/projects');
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  return (
    <main className="auth-shell">
      <section className="card auth-card">
        <h1>ContentOps AI</h1>
        <p>Admin access</p>
        {error ? <div className="msg error">{error}</div> : null}
        <form onSubmit={onSubmit}>
          <div className="form-row" style={{ gridTemplateColumns: '1fr' }}>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          <button type="submit">Login</button>
        </form>
      </section>
    </main>
  );
}
