import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { ForumVisibility, getForumVisibility, setForumVisibility as saveForumVisibility } from '../services/storageService';

interface ForumVisibilityContextType {
  visibility: ForumVisibility;
  updateVisibility: (forum: 'stockInsights' | 'optionsInsights', value: boolean) => Promise<void>;
  loading: boolean;
}

const ForumVisibilityContext = createContext<ForumVisibilityContextType | undefined>(undefined);

export function ForumVisibilityProvider({ children }: { children: React.ReactNode }) {
  const [visibility, setVisibility] = useState<ForumVisibility>({
    stockInsights: false,
    optionsInsights: false,
  });
  const [loading, setLoading] = useState(true);

  // Load initial preferences on mount
  useEffect(() => {
    loadPreferences();
  }, []);

  async function loadPreferences() {
    const prefs = await getForumVisibility();
    setVisibility(prefs);
    setLoading(false);
  }

  const updateVisibility = useCallback(
    async (forum: 'stockInsights' | 'optionsInsights', value: boolean) => {
      const updated = { ...visibility, [forum]: value };
      setVisibility(updated); // Immediate state update for instant UI feedback
      await saveForumVisibility(updated); // Persist to storage
    },
    [visibility]
  );

  return (
    <ForumVisibilityContext.Provider value={{ visibility, updateVisibility, loading }}>
      {children}
    </ForumVisibilityContext.Provider>
  );
}

export function useForumVisibility() {
  const context = useContext(ForumVisibilityContext);
  if (!context) {
    throw new Error('useForumVisibility must be used within ForumVisibilityProvider');
  }
  return context;
}
