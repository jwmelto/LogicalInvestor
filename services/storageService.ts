import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as CloudSettings from '@nauverse/expo-cloud-settings';

const useICloud = Platform.OS === 'ios' && CloudSettings.isAvailable();

export async function storageGet(key: string): Promise<string | null> {
  if (useICloud) {
    return CloudSettings.getString(key) ?? null;
  }
  return AsyncStorage.getItem(key);
}

export async function storageSet(key: string, value: string): Promise<void> {
  if (useICloud) {
    CloudSettings.setString(key, value);
    return;
  }
  await AsyncStorage.setItem(key, value);
}

export async function storageRemove(key: string): Promise<void> {
  if (useICloud) {
    CloudSettings.remove(key);
    return;
  }
  await AsyncStorage.removeItem(key);
}

export async function storageGetObject<T>(key: string): Promise<T | null> {
  if (useICloud) {
    return CloudSettings.getObject<T>(key) ?? null;
  }
  const val = await AsyncStorage.getItem(key);
  return val ? JSON.parse(val) : null;
}

export async function storageSetObject<T>(key: string, value: T): Promise<void> {
  if (useICloud) {
    CloudSettings.setObject(key, value as object);
    return;
  }
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

// Display preferences
export async function getHideSnippetOnRead(): Promise<boolean> {
  const val = await storageGet('hideSnippetOnRead');
  return val === 'true';
}

export async function setHideSnippetOnRead(value: boolean): Promise<void> {
  await storageSet('hideSnippetOnRead', value ? 'true' : 'false');
}
