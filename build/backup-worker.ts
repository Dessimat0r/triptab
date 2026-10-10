// Separate entrypoint: this build never imports the app, its scheduled cleanup,
// auth handlers or model clients. All normal requests receive maintenance503.
import { createBackupHandler } from '../lib/operator-backup';
import { exportDatabaseSql, inspectD1ExportMetadata } from '../lib/operator-backup-sql';

const fetch = createBackupHandler({ exportDatabaseSql, inspectDatabase: inspectD1ExportMetadata });
export default {
  fetch,
  // Remain inert even if the host retains a previously configured Cron trigger.
  scheduled() {},
};
