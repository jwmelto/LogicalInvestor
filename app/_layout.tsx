import { useEffect, useState } from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';

// Keep the splash screen visible until we've checked auth state
SplashScreen.preventAutoHideAsync();

import * as Notifications from 'expo-notifications';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useNotificationPermissions } from '@/hooks/use-notification-permissions';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});
import { isAuthenticated } from '../services/authService';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { ForumVisibilityProvider } from '../contexts/ForumVisibilityContext';
import { UnreadCountProvider } from '../contexts/UnreadCountContext';
import { registerBackgroundFetch } from '../services/backgroundFetchService';

function RootLayoutInner() {
  const colorScheme = useColorScheme();
  const { authed, setAuthed } = useAuth();
  const [loading, setLoading] = useState(true);
  useNotificationPermissions();

  useEffect(() => {
    isAuthenticated().then((result) => {
      setAuthed(result);
      setLoading(false);
      SplashScreen.hideAsync();
    });

    registerBackgroundFetch();
  }, []);


  if (loading) return null; // splash screen is still visible during this time

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

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootLayoutInner />
    </AuthProvider>
  );
}
