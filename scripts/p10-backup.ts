import { backupWorkspace, restoreWorkspace } from '../packages/core/operations.js';
const [action, source, destination, confirmation] = process.argv.slice(2);
if (
  !source ||
  !destination ||
  !['backup', 'restore'].includes(action) ||
  confirmation !== '--writers-stopped'
)
  throw new Error('Usage: p10-backup.ts backup|restore SOURCE NEW_DESTINATION --writers-stopped');
console.log(
  JSON.stringify(
    action === 'backup' ? await backupWorkspace(source, destination) : restoreWorkspace(source, destination),
    null,
    2,
  ),
);
