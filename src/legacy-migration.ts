/**
 * The one-time move from a hand-edited `members.json` to the member store.
 *
 * IT LIVES HERE RATHER THAN IN `main.ts` SO IT CAN BE TESTED. This runs exactly
 * once in the life of a deployment, on the upgrade boot, against a file the
 * operator has been maintaining by hand — which is to say it is code that gets
 * one attempt, unattended, on somebody else's box. A test that boots it twice
 * against one state directory and asserts no member was duplicated is worth
 * more than the fifteen lines it costs to make it callable.
 *
 * ONCE, NOT ON EVERY BOOT. `mergeLegacyOnce` records `legacyMigratedAt` in the
 * store, and every later boot is a no-op. The alternative — re-merging whenever
 * the file is present — would reinstate a member the operator had revoked
 * through the admin API, because the old file still names them. That is a
 * revocation quietly undoing itself on the next restart, which is the worst
 * shape a security bug can take.
 *
 * A BACKUP FIRST, BESIDE THE STORE. This is the moment the legacy file stops
 * being the source of truth, so `members.json.bak` is what an operator restores
 * from if the migration turns out to be wrong. It is written next to the MEMBER
 * STORE rather than next to the legacy file, because the legacy file is
 * frequently mounted read-only — the shipped compose file does exactly that —
 * and writing beside it would fail on the one deployment shape that most needs
 * the migration to work.
 */
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from './logger.js';
import type { MemberStore } from './member-store.js';
import { loadLegacyMembersFileIfPresent } from './members.js';

export interface MigrateLegacyMembersOptions {
  /** The hand-edited registry, from `MEMBERS_FILE`. Absent is normal. */
  legacyMembersFile: string;
  /** The store file, from `MEMBER_STORE_FILE`. Its directory receives the backup. */
  memberStoreFile: string;
  members: MemberStore;
  logger: Logger;
}

export async function migrateLegacyMembers(options: MigrateLegacyMembersOptions): Promise<void> {
  const { legacyMembersFile, memberStoreFile, members, logger } = options;

  const legacy = await loadLegacyMembersFileIfPresent(legacyMembersFile);
  if (legacy === null) return;

  const backupPath = join(dirname(memberStoreFile), 'members.json.bak');
  const result = await members.mergeLegacyOnce({
    members: legacy.members,
    // Inside the store's lock, so it runs on the first merge and only then.
    beforeMerge: async () => {
      await copyFile(legacyMembersFile, backupPath);
    },
  });

  if (!result.migrated) {
    logger.info('Legacy members file ignored; it was already migrated', {
      membersFile: legacyMembersFile,
    });
    return;
  }

  logger.info('Legacy members file migrated into the member store', {
    membersFile: legacyMembersFile,
    backupPath,
    added: result.added,
  });
}
