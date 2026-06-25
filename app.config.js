const { withEntitlementsPlist } = require('expo/config-plugins');
const { version } = require('./package.json');
const appJson = require('./app.json');

module.exports = withEntitlementsPlist(
  {
    ...appJson.expo,
    version,
    ios: {
      ...appJson.expo.ios,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
      },
    },
  },
  (mod) => {
    // EAS capability sync only recognizes iCloud via icloud-container-identifiers;
    // it ignores ubiquity-kvstore-identifier and disables iCloud in the App ID
    // on every build without a real container entry. Set explicit values so EAS
    // keeps iCloud enabled and the provisioning profile includes all entitlements.
    mod.modResults['com.apple.developer.icloud-container-identifiers'] = [
      'iCloud.space.melton.logicalinvestor',
    ];
    mod.modResults['com.apple.developer.icloud-services'] = ['CloudKit'];
    mod.modResults['com.apple.developer.icloud-container-environment'] = 'Production';
    return mod;
  }
);
