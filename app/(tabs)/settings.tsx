import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { logout } from '../../services/authService';
import { getHideSnippetOnRead, setHideSnippetOnRead } from '../../services/storageService';

export default function SettingsScreen() {
  const [hideSnippet, setHideSnippet] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPreference();
  }, []);

  async function loadPreference() {
    const value = await getHideSnippetOnRead();
    setHideSnippet(value);
    setLoading(false);
  }

  async function handleToggleHideSnippet(value: boolean) {
    setHideSnippet(value);
    await setHideSnippetOnRead(value);
  }

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Display</Text>
        <View style={styles.preference}>
          <Text style={styles.preferenceLabel}>Hide snippets on read items</Text>
          <Switch
            value={hideSnippet}
            onValueChange={handleToggleHideSnippet}
            disabled={loading}
          />
        </View>
      </View>

      <View style={styles.section}>
        <TouchableOpacity style={styles.button} onPress={handleLogout}>
          <Text style={styles.buttonText}>Log Out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 32 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#888', marginBottom: 12, textTransform: 'uppercase' },
  preference: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' },
  preferenceLabel: { fontSize: 16, color: '#1a1a1a' },
  button: { backgroundColor: '#cc0000', borderRadius: 8, padding: 16, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
