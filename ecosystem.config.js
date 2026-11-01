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
      // Absolute path: in cluster mode PM2 starts workers from its own install
      // dir, where a bare `-r source-map-support/register` can't be resolved
      // ("Cannot find module") and every worker crash-loops.
      node_args: `-r ${require.resolve('source-map-support/register')}`,
      // Was fork mode with an implicit single instance — every concurrent
      // request (go-live: ~100 staff logging in/searching at once) funneled
      // through ONE Node event loop on ONE CPU core, so one slow request
      // stalled everyone else's too. Cluster mode load-balances across
      // instances/cores instead.
      //
      // `instances: 2` is a conservative starting point, NOT a measured
      // number — this server also runs migration (and, when active,
      // staging) side by side, so going higher without checking actual
      // core count (`nproc` on the server) risks starving them instead.
      // Raise it after confirming cores are actually free, and raise
      // PG_POOL_MAX (pressto.datasource.ts) in step — more instances means
      // more separate connection pools against the same Postgres server.
      //
      // Switching exec_mode requires a fresh start, not a plain restart:
      //   pm2 delete pressto-prod-backend
      //   pm2 start ecosystem.config.js --name pressto-prod-backend
      exec_mode: 'cluster',
      instances: Number(process.env.PM2_INSTANCES) || 2,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
