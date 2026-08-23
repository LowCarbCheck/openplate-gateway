/**
 * The member store, and the one-time migration that fills it.
 *
 * THE MIGRATION TEST IS THE POINT OF THIS FILE. It runs exactly once per
 * deployment, unattended, on the upgrade boot, against a file the operator has
 * been maintaining by hand — and its two failure modes are both silent. Merging
 * twice duplicates every member (or, worse, reinstates one that was revoked in
 * between); not merging at all revokes the whole household. Neither shows up as
 * an error anywhere. So the migration is booted TWICE against one state
 * directory here, with a revocation in the middle, which is the sequence a real
 * upgrade produces and the one where a re-merge would undo a security decision.
 *
 * Every store in this file is a REAL file store on a temp directory. A fake
 * would agree with the interface and disagree with the atomic write and the
 * lock, which is most of what the store is.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateLegacyMembers } from '../../src/legacy-migration.js';
import { createSilentLogger } from '../../src/logger.js';
import {
  MemberConflictError,
  MemberNotFoundError,
  createFileMemberStore,
  type MemberStore,
} from '../../src/member-store.js';
import { sha256Hex } from '../support/app-harness.js';

let stateDir = '';
let storePath = '';
let legacyPath = '';

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'opgw-store-'));
  storePath = join(stateDir, 'member-store.json');
  legacyPath = join(stateDir, 'members.json');
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function newStore(): MemberStore {
  return createFileMemberStore(storePath);
}

async function writeLegacyFile(members: readonly { id: string; token: string; dailyLimit: number }[]): Promise<void> {
  await writeFile(
    legacyPath,
    JSON.stringify({
      members: members.map((member) => ({
        id: member.id,
        tokenSha256: sha256Hex(member.token),
        dailyLimit: member.dailyLimit,
      })),
    }),
    'utf8',
  );
}

/** One boot's worth of migration, through the REAL function `main.ts` calls. */
function boot(store: MemberStore): Promise<void> {
  return migrateLegacyMembers({
    legacyMembersFile: legacyPath,
    memberStoreFile: storePath,
    members: store,
    logger: createSilentLogger(),
  });
}

describe('member store CRUD', () => {
  it('creates a member and reads it back', async () => {
    const store = newStore();

    const created = await store.create({
      id: 'alex',
      tokenSha256: sha256Hex('a-token'),
      dailyLimit: 50,
      mode: 'family',
    });

    expect(created.id).toBe('alex');
    expect(created.dailyLimit).toBe(50);
    expect(created.mode).toBe('family');
    expect(created.revokedAt).toBeUndefined();
    expect(await store.all()).toHaveLength(1);
  });

  it('survives being reopened, because the state is the file and not the object', async () => {
    await newStore().create({
      id: 'alex',
      tokenSha256: sha256Hex('a-token'),
      dailyLimit: 50,
      mode: 'family',
    });

    const reopened = await newStore().all();

    expect(reopened.map((member) => member.id)).toEqual(['alex']);
  });

  it('writes a version field, so a later format change has something to branch on', async () => {
    await newStore().create({
      id: 'alex',
      tokenSha256: sha256Hex('a-token'),
      dailyLimit: 50,
      mode: 'family',
    });

    const raw: unknown = JSON.parse(await readFile(storePath, 'utf8'));

    expect(raw).toMatchObject({ version: 1 });
  });

  it('NEVER writes the token, only its digest', async () => {
    const token = 'a-very-recognisable-member-token';
    await newStore().create({
      id: 'alex',
      tokenSha256: sha256Hex(token),
      dailyLimit: 50,
      mode: 'family',
    });

    const contents = await readFile(storePath, 'utf8');

    expect(contents).not.toContain(token);
    expect(contents).toContain(sha256Hex(token));
  });

  it('refuses a duplicate id', async () => {
    const store = newStore();
    await store.create({ id: 'alex', tokenSha256: sha256Hex('one'), dailyLimit: 50, mode: 'family' });

    await expect(
      store.create({ id: 'alex', tokenSha256: sha256Hex('two'), dailyLimit: 50, mode: 'family' }),
    ).rejects.toThrow(MemberConflictError);
  });

  it('refuses a duplicate digest, which would silently halve a household cap', async () => {
    // Two members sharing a token authenticate as whichever the lookup finds and
    // share ONE allowance. Nothing errors at request time; the household's cap
    // is simply half what the roster says.
    const store = newStore();
    const shared = sha256Hex('the-same-token');
    await store.create({ id: 'alex', tokenSha256: shared, dailyLimit: 50, mode: 'family' });

    await expect(
      store.create({ id: 'sam', tokenSha256: shared, dailyLimit: 50, mode: 'family' }),
    ).rejects.toThrow(MemberConflictError);
  });

  it('does not name the colliding member when a digest is reused', async () => {
    const store = newStore();
    const shared = sha256Hex('the-same-token');
    await store.create({ id: 'alex', tokenSha256: shared, dailyLimit: 50, mode: 'family' });

    let message = '';
    try {
      await store.create({ id: 'sam', tokenSha256: shared, dailyLimit: 50, mode: 'family' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Naming the holder would turn a minting collision into a lookup.
    expect(message).not.toContain('alex');
  });

  it('revokes with a tombstone rather than a delete', async () => {
    const store = newStore();
    await store.create({ id: 'alex', tokenSha256: sha256Hex('one'), dailyLimit: 50, mode: 'family' });

    const revoked = await store.revoke('alex');

    expect(revoked.revokedAt).toBeTruthy();
    // Still present: the id keeps meaning one person, and the row is what stops
    // a later merge quietly reinstating the token.
    expect(await store.all()).toHaveLength(1);
  });

  it('keeps the first revocation timestamp when revoked twice', async () => {
    const store = newStore();
    await store.create({ id: 'alex', tokenSha256: sha256Hex('one'), dailyLimit: 50, mode: 'family' });

    const first = await store.revoke('alex');
    const second = await store.revoke('alex');

    // Otherwise "when did this person lose access" answers whenever it was last asked.
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('throws a distinguishable error for an unknown member', async () => {
    await expect(newStore().revoke('nobody')).rejects.toThrow(MemberNotFoundError);
  });

  it('refuses to overwrite a store file it cannot parse', async () => {
    // The alternative — treating a corrupt file as empty — would replace every
    // member's identity with nothing on the next write. That is not recoverable.
    await writeFile(storePath, '{ this is not json', 'utf8');

    await expect(newStore().all()).rejects.toThrow(/not valid JSON/);
  });
});

describe('the one-time legacy migration', () => {
  it('folds a hand-edited members.json into the store', async () => {
    await writeLegacyFile([{ id: 'alex', token: 'alex-token', dailyLimit: 50 }]);

    await boot(newStore());

    const members = await newStore().all();
    expect(members.map((member) => member.id)).toEqual(['alex']);
    expect(members[0]?.dailyLimit).toBe(50);
    // A legacy file predates modes entirely; family is the only one that existed.
    expect(members[0]?.mode).toBe('family');
  });

  it('takes a backup beside the store before it merges', async () => {
    await writeLegacyFile([{ id: 'alex', token: 'alex-token', dailyLimit: 50 }]);

    await boot(newStore());

    const backup: unknown = JSON.parse(await readFile(join(stateDir, 'members.json.bak'), 'utf8'));
    expect(backup).toMatchObject({ members: [{ id: 'alex' }] });
  });

  it('adds nothing on a SECOND boot against the same state directory', async () => {
    // The duplicate-member failure, which is silent: two rows, one id, and a
    // roster that grows by the size of the legacy file on every restart.
    await writeLegacyFile([
      { id: 'alex', token: 'alex-token', dailyLimit: 50 },
      { id: 'sam', token: 'sam-token', dailyLimit: 20 },
    ]);

    await boot(newStore());
    await boot(newStore());
    await boot(newStore());

    const members = await newStore().all();
    expect(members.map((member) => member.id)).toEqual(['alex', 'sam']);
  });

  it('does NOT reinstate a member revoked after the migration', async () => {
    // The failure this test exists for. The legacy file still names `alex`, so
    // a merge-on-every-boot would hand them a working token again on the next
    // restart — a revocation undoing itself, with nothing in the log.
    await writeLegacyFile([{ id: 'alex', token: 'alex-token', dailyLimit: 50 }]);
    await boot(newStore());
    await newStore().revoke('alex');

    await boot(newStore());

    const members = await newStore().all();
    expect(members).toHaveLength(1);
    expect(members[0]?.revokedAt).toBeTruthy();
  });

  it('is a no-op when there is no legacy file at all', async () => {
    // The normal state of a gateway installed after ADR-0002.
    await boot(newStore());

    expect(await newStore().all()).toEqual([]);
  });

  it('throws when the legacy file exists and does not parse', async () => {
    // Absent and malformed are NOT the same answer: an operator with a broken
    // members.json believes in the members inside it, and booting without them
    // silently revokes the household.
    await writeFile(legacyPath, 'not json at all', 'utf8');

    await expect(boot(newStore())).rejects.toThrow(/not valid JSON/);
  });
});
