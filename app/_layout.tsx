import { useEffect, useState } from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { useNotificationPermissions } from '@/hooks/use-notification-permissions';
import { isAuthenticated } from '../services/authService';
import { ForumVisibilityProvider } from '../contexts/ForumVisibilityContext';
import { UnreadCountProvider } from '../contexts/UnreadCountContext';
import { registerBackgroundFetch } from '../services/backgroundFetchService';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  useNotificationPermissions(); // Request permissions on app launch

  useEffect(() => {
    isAuthenticated().then((result) => {
      setAuthed(result);
      setLoading(false);
    });

    registerBackgroundFetch();
  }, []);

  if (loading) return null;

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <ForumVisibilityProvider>
        <UnreadCountProvider>
          <Stack>
            <Stack.Protected guard={authed}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Feed' }} />
              <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
            </Stack.Protected>
            <Stack.Screen name="login" options={{ headerShown: false }} />
          </Stack>
          <StatusBar style="auto" />
        </UnreadCountProvider>
      </ForumVisibilityProvider>
    </ThemeProvider>
  );
}
