import { useEffect, useState } from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { isAuthenticated } from '../services/authService';
import { ForumVisibilityProvider } from '../contexts/ForumVisibilityContext';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    isAuthenticated().then((result) => {
      setAuthed(result);
      setLoading(false);
    });
  }, []);

  if (loading) return null;

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <ForumVisibilityProvider>
        <Stack>
          <Stack.Protected guard={authed}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Feed' }} />
            <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
            <Stack.Screen name="post" options={{ headerShown: true, title: '', headerBackTitle: 'Back' }} />
          </Stack.Protected>
          <Stack.Screen name="login" options={{ headerShown: false }} />
        </Stack>
        <StatusBar style="auto" />
      </ForumVisibilityProvider>
    </ThemeProvider>
  );
}
