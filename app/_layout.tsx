import { useEffect, useState } from 'react';
import { Linking , Platform } from 'react-native';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import 'react-native-reanimated';

import * as Notifications from 'expo-notifications';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useNotificationPermissions } from '@/hooks/use-notification-permissions';
import { FEED_ALERTS_CHANNEL_ID } from '../services/notificationService';
import { isAuthenticated } from '../services/authService';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { ForumVisibilityProvider } from '../contexts/ForumVisibilityContext';
import { FeedProvider } from '../contexts/FeedContext';
import { registerBackgroundFetch } from '../services/backgroundFetchService';

// Keep the splash screen visible until we've checked auth state
SplashScreen.preventAutoHideAsync();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

if (Platform.OS === 'android') {
  void Notifications.setNotificationChannelAsync(FEED_ALERTS_CHANNEL_ID, {
    name: 'Feed Alerts',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
  });
}

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

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const link = response.notification.request.content.data?.link as string | undefined;
      if (link) Linking.openURL(link);
    });
    return () => sub.remove();
  }, [setAuthed]);


  if (loading) return null; // splash screen is still visible during this time

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <ForumVisibilityProvider>
        <FeedProvider>
          <Stack>
            <Stack.Protected guard={authed}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Feed' }} />
              <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
            </Stack.Protected>
            <Stack.Screen name="login" options={{ headerShown: false }} />
          </Stack>
          <StatusBar style="auto" />
        </FeedProvider>
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
