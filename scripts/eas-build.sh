#!/bin/bash
# Submit production EAS builds for both platforms without blocking, so they
# queue concurrently. iOS first — it's typically serviced faster in the queue.
set -e

export EAS_BUILD_NO_EXPO_GO_WARNING=true    # dev workflow uses expo prebuild + native builds, not the Expo Go app — false positive
export EAS_BUILD_SKIP_LOCKFILE_CHECK=1      # package-lock.json is intentionally gitignored, so EAS's local check for it always fails

eas build --platform ios --profile production --no-wait --non-interactive
eas build --platform android --profile production --no-wait --non-interactive
