import React, { createContext, useContext, useState, useCallback } from 'react';

interface AuthContextType {
  authed: boolean;
  setAuthed: (value: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authed, setAuthedState] = useState(false);

  const setAuthed = useCallback((value: boolean) => {
    setAuthedState(value);
  }, []);

  return (
    <AuthContext.Provider value={{ authed, setAuthed }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
