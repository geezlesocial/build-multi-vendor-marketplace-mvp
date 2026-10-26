import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: 'BUYER' | 'SELLER' | 'CASHIER' | 'ADMIN' | 'CONTENT_EDITOR';
  emailVerifiedAt?: string | null;
  sellerId?: string;
  avatarUrl?: string;
};

type SessionStatus = 'loading' | 'ready' | 'error';
type SessionContextValue = {
  user: SessionUser | null;
  status: SessionStatus;
  error: string;
  setUser: (user: SessionUser | null) => void;
  refreshUser: () => Promise<SessionUser | null>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

async function readSessionResponse(response: Response): Promise<{ user: SessionUser | null }> {
  const raw = await response.text();
  let payload: unknown = null;
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      if (response.ok) throw new Error('The marketplace API returned an invalid session response. Check the API server output.');
    }
  }

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `The marketplace API returned HTTP ${response.status} while checking your account. Check the API server output.`;
    throw new Error(message);
  }

  if (!payload || typeof payload !== 'object' || !('user' in payload) || (payload.user !== null && typeof payload.user !== 'object')) {
    throw new Error('The marketplace API returned an empty or invalid session response. Check the API server output.');
  }
  return payload as { user: SessionUser | null };
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [error, setError] = useState('');
  const hasResolvedSession = useRef(false);

  const refreshUser = useCallback(async () => {
    const initialCheck = !hasResolvedSession.current;
    if (initialCheck) setStatus('loading');
    try {
      const response = await fetch('/api/auth/me', { credentials: 'include' });
      const body = await readSessionResponse(response);
      hasResolvedSession.current = true;
      setUserState(body.user);
      setStatus('ready');
      setError('');
      return body.user;
    } catch (reason) {
      const message = reason instanceof TypeError
        ? 'The marketplace API could not be reached. Start the API with npm run dev and check its terminal output.'
        : (reason as Error).message || 'Could not check your account.';
      setError(message);
      if (initialCheck) setStatus('error');
      return null;
    }
  }, []);

  const setUser = useCallback((nextUser: SessionUser | null) => {
    hasResolvedSession.current = true;
    setUserState(nextUser);
    setStatus('ready');
    setError('');
  }, []);

  useEffect(() => { void refreshUser(); }, [refreshUser]);
  const value = useMemo(() => ({ user, status, error, setUser, refreshUser }), [user, status, error, setUser, refreshUser]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used within SessionProvider');
  return value;
}
