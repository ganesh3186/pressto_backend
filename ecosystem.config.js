// PM2 process definition for this backend, standalone.
// Run from inside this folder:
//
//   pm2 start ecosystem.config.js
//   pm2 save                       # remembers it across reboots
//
// If admin-panel/customer-web are deployed as siblings on the same server,
// each has its own matching ecosystem.config.js on its own client-server
// branch — start all three the same way, one `pm2 start` per repo.

module.exports = {
  apps: [
    {
      name: 'pressto-backend',
      cwd: '.',
      script: 'dist/index.js',
      node_args: '-r source-map-support/register',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
