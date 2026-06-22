const { version } = require('./package.json');
const appJson = require('./app.json');

module.exports = {
  ...appJson.expo,
  version,
};
