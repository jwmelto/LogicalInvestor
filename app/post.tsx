import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { useEffect, useState } from 'react';
import { getToken } from '../services/authService';

export default function PostScreen() {
  const { url, title } = useLocalSearchParams<{ url: string; title: string }>();
  const [finalUrl, setFinalUrl] = useState<string | null>(null);

  useEffect(() => {
    getToken().then((token) => {
      const urlObj = new URL(url);
      urlObj.searchParams.set('feed_token', token ?? '');
      const final = urlObj.toString();
      console.log('Loading URL:', final);
      setFinalUrl(final);
    });
  }, [url]);

  if (!finalUrl) return null;

  return (
    <SafeAreaView style={styles.container}>
      <WebView source={{ uri: finalUrl }} style={styles.webview} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
});