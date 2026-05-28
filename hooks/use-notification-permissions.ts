import { useEffect, useState } from 'react';
import * as Notifications from 'expo-notifications';

/**
 * Hook to request notification permissions and track their status
 * Returns { hasPermission: boolean; requesting: boolean }
 */
export function useNotificationPermissions() {
  const [hasPermission, setHasPermission] = useState(false);
  const [requesting, setRequesting] = useState(true);

  useEffect(() => {
    requestNotificationPermissions();
  }, []);

  async function requestNotificationPermissions() {
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      setHasPermission(finalStatus === 'granted');
    } catch (error) {
      console.error('Error requesting notification permissions:', error);
      setHasPermission(false);
    } finally {
      setRequesting(false);
    }
  }

  return { hasPermission, requesting };
}
