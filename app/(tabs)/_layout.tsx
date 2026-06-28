import { Tabs } from 'expo-router';
import React from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useForumVisibility } from '@/contexts/ForumVisibilityContext';
import { useFeed } from '@/contexts/FeedContext';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const { visibility: forumVisibility } = useForumVisibility();
  const { counts } = useFeed();

  function badge(feedKey: keyof typeof counts) {
    const n = counts[feedKey];
    return n && n > 0 ? '' : undefined;
  }

  return (
    <Tabs
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
        name="members-area"
        options={{
          title: 'Members Area',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="house.fill" color={color} />,
          tabBarBadge: badge('membersArea'),
        }}
      />
      <Tabs.Screen
        name="members-forum"
        options={{
          title: 'Members Forum',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="bubble.left.and.bubble.right.fill" color={color} />,
          tabBarBadge: badge('membersForum'),
        }}
      />
      <Tabs.Screen
        name="stock-insights"
        options={{
          title: 'Stock Insights',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="chart.line.uptrend.xyaxis" color={color} />,
          href: forumVisibility.stockInsights ? undefined : null,
          tabBarBadge: badge('stockInsights'),
        }}
      />
      <Tabs.Screen
        name="options-insights"
        options={{
          title: 'Options Insights',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="chart.line.uptrend.xyaxis" color={color} />,
          href: forumVisibility.optionsInsights ? undefined : null,
          tabBarBadge: badge('optionsInsights'),
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
