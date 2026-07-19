import { Tabs } from 'expo-router';
import React from 'react';
import { FeedKeys } from '@li/core';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useForumVisibility } from '@/contexts/ForumVisibilityContext';
import { useFeed } from '@/contexts/FeedContext';
import { setLastOpenedTab } from '@/services/storageService';
import { FeedKey, FEEDS } from '@/services/feedService';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const { visibility: forumVisibility } = useForumVisibility();
  const { unread } = useFeed();

  function badge(feedKey: keyof typeof unread) {
    return unread[feedKey] ? '' : undefined;
  }

  const ROUTE_TO_FEED_KEY = Object.fromEntries(
    (Object.keys(FEEDS) as FeedKey[]).map((k) => [FEEDS[k].route, k])
  ) as Record<string, FeedKey>;

  return (
    <Tabs
      screenListeners={({ route }) => ({
        focus: () => {
          const feedKey = ROUTE_TO_FEED_KEY[route.name];
          if (feedKey) setLastOpenedTab(feedKey);
        },
      })}
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme ?? 'light'].tint,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarBadgeStyle: { transform: [{ scale: 0.5 }] },

      }}>
      <Tabs.Screen
        name="index"
        options={{
          href: null,
        }}
      />
      <Tabs.Screen
        name={FEEDS.membersArea.route}
        options={{
          title: 'Members Area',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
          tabBarBadge: badge(FeedKeys.membersArea),
        }}
      />
      <Tabs.Screen
        name={FEEDS.membersForum.route}
        options={{
          title: 'Members Forum',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="bubble.left.and.bubble.right.fill" color={color} />,
          tabBarBadge: badge(FeedKeys.membersForum),
        }}
      />
      <Tabs.Screen
        name={FEEDS.stockInsights.route}
        options={{
          title: 'Stock Insights',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="chart.line.uptrend.xyaxis" color={color} />,
          href: forumVisibility.stockInsights ? undefined : null,
          tabBarBadge: badge(FeedKeys.stockInsights),
        }}
      />
      <Tabs.Screen
        name={FEEDS.optionsInsights.route}
        options={{
          title: 'Options Insights',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="chart.line.uptrend.xyaxis" color={color} />,
          href: forumVisibility.optionsInsights ? undefined : null,
          tabBarBadge: badge(FeedKeys.optionsInsights),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="gearshape.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}
