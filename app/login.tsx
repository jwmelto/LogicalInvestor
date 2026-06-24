import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { login } from '../services/authService';
import { useAuth } from '../contexts/AuthContext';
import { useColorScheme } from '../hooks/use-color-scheme';

export default function LoginScreen() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setAuthed } = useAuth();
  const scheme = useColorScheme();
  const dark = scheme === 'dark';

  async function handleLogin() {
    if (!username || !password) {
      setError('Please enter your username and password');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await login(username, password);
      setAuthed(true);
      router.replace('/(tabs)');
    } catch (e: any) {
      setError(e.message ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  const c = dark ? colors.dark : colors.light;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Banner */}
        <View style={styles.bannerContainer}>
          <Image
            source={require('../assets/images/banner.jpg')}
            style={styles.banner}
            resizeMode="cover"
          />
        </View>

        {/* Form — fills remaining space, content centered */}
        <View style={styles.form}>
          <Text style={[styles.subtitle, { color: c.subtle }]}>
            Log in to logicalinvestor.net
          </Text>

          {error && <Text style={styles.error}>{error}</Text>}

          <TextInput
            style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.inputBg }]}
            placeholder="Username"
            placeholderTextColor={c.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            value={username}
            onChangeText={setUsername}
          />

          <TextInput
            style={[styles.input, { borderColor: c.border, color: c.text, backgroundColor: c.inputBg }]}
            placeholder="Password"
            placeholderTextColor={c.placeholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password"
            textContentType="password"
            value={password}
            onChangeText={setPassword}
          />

          <TouchableOpacity
            style={styles.button}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>Sign In</Text>
            }
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => Linking.openURL('https://logicalinvestor.net/product/monthly-newsletter/')}
          >
            <Text style={[styles.signUpLink, { color: c.subtle }]}>
              Not a subscriber? <Text style={styles.signUpLinkBold}>Sign up</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const colors = {
  light: {
    bg:          '#ffffff',
    text:        '#111111',
    subtle:      '#555555',
    placeholder: '#aaaaaa',
    border:      '#dddddd',
    inputBg:     '#ffffff',
  },
  dark: {
    bg:          '#2b2d32',
    text:        '#f0f0f0',
    subtle:      '#9fc4e0',
    placeholder: '#666c7a',
    border:      '#444850',
    inputBg:     '#35373d',
  },
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  bannerContainer: {
    width: '100%',
    aspectRatio: 780 / 192,
  },
  banner: {
    width: '100%',
    height: '100%',
  },
  form: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 24,
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 28,
  },
  error: {
    color: '#cc3333',
    textAlign: 'center',
    marginBottom: 16,
    fontSize: 14,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    marginBottom: 16,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  signUpLink: {
    textAlign: 'center',
    fontSize: 14,
    marginTop: 20,
  },
  signUpLinkBold: {
    fontWeight: '600',
    color: '#2563eb',
  },
});
