import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: 'BUYER' | 'SELLER' | 'CASHIER' | 'ADMIN' | 'CONTENT_EDITOR';
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
      const body = await response.json() as { user: SessionUser | null; error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not check your account.');
      hasResolvedSession.current = true;
      setUserState(body.user);
      setStatus('ready');
      setError('');
      return body.user;
    } catch (reason) {
      setError((reason as Error).message || 'Could not check your account.');
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
