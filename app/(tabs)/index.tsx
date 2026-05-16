import { useEffect } from 'react';
import { useRouter } from 'expo-router';

export default function TabsIndex() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/(tabs)/members-area');
  }, [router]);

  return null;
}
