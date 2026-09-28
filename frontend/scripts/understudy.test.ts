/**
 * 数据层（IndexedDB / Dexie）迁移与导入兼容校验。
 * 运行前先：npm install --no-save fake-indexeddb
 * 然后：npx esbuild scripts/understudy.test.ts --bundle --platform=node \
 *        --format=esm --outfile=/tmp/t.mjs && node /tmp/t.mjs
 */
import 'fake-indexeddb/auto';
import {
  db,
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  importSnapshot,
  type DatabaseSnapshot,
} from '../src/utils/db';
import type { ShadowRole } from '../src/types/role';
import type { Operator } from '../src/types/operator';
import type { PercussionCue } from '../src/types/cue';

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`PASS ${label}`);
  } else {
    console.error(`FAIL ${label}`);
    process.exitCode = 1;
  }
}

const now = new Date().toISOString();
const operators: Operator[] = [
  {
    id: 'op-a', name: '甲', skillTags: [], busySlots: [], assignedRoleIds: [], rehearsalHours: 0,
    createdAt: now, updatedAt: now,
  },
  {
    id: 'op-b', name: '乙', skillTags: [], busySlots: [], assignedRoleIds: [], rehearsalHours: 0,
    createdAt: now, updatedAt: now,
  },
  {
    id: 'op-c', name: '丙', skillTags: [], busySlots: [], assignedRoleIds: [], rehearsalHours: 0,
    createdAt: now, updatedAt: now,
  },
];

const baseSnapshot = (roles: ShadowRole[]): DatabaseSnapshot => ({
  name: 'gbshadowplay',
  schemaVersion: 2,
  exportedAt: now,
  plays: [],
  scenes: [],
  roles,
  operators,
  cues: [] as PercussionCue[],
});

async function main() {
  await db.open();
  assert(db.verno === DB_SCHEMA_VERSION, `fresh DB schema version = ${DB_SCHEMA_VERSION}`);

  // ---- Case 1: old save (no understudy fields at all) imports without error ----
  const oldRole = {
    id: 'r1', sceneId: 's1', name: '旧角色', roleType: 'dan', propParts: [],
    entranceCue: '', lineNote: '', operatorId: 'op-a', createdAt: now, updatedAt: now,
  } as unknown as ShadowRole;
  await importSnapshot(baseSnapshot([oldRole]));
  const r1 = await db.roles.get('r1');
  assert(!!r1, 'old role imported');
  assert(r1?.understudyOperatorId === null, 'old role gets understudyOperatorId = null');
  assert(r1?.understudyOn === false, 'old role gets understudyOn = false');
  assert(r1?.revision === ROW_REVISION, `old role revision = ${ROW_REVISION}`);

  // ---- Case 2: dangling understudy (operator not in archive) is dropped ----
  const dangling: ShadowRole = {
    id: 'r2', sceneId: 's1', name: '悬挂替演', roleType: 'sheng', propParts: [],
    entranceCue: '', lineNote: '', operatorId: 'op-a',
    understudyOperatorId: 'op-ghost', understudyOn: true,
    createdAt: now, updatedAt: now,
  };
  await importSnapshot(baseSnapshot([dangling]));
  const r2 = await db.roles.get('r2');
  assert(r2?.understudyOperatorId === null, 'dangling understudy ref cleared');
  assert(r2?.understudyOn === false, 'on-stage flag withdrawn when understudy missing');

  // ---- Case 3: valid swapped (handover) state imports intact ----
  const swapped: ShadowRole = {
    id: 'r3', sceneId: 's1', name: '接场中', roleType: 'chou', propParts: [],
    entranceCue: '', lineNote: '', operatorId: 'op-b',
    understudyOperatorId: 'op-a', understudyOn: true,
    createdAt: now, updatedAt: now,
  };
  await importSnapshot(baseSnapshot([swapped]));
  const r3 = await db.roles.get('r3');
  assert(r3?.operatorId === 'op-b' && r3?.understudyOperatorId === 'op-a', 'handover pair preserved');
  assert(r3?.understudyOn === true, 'on-stage flag preserved when pair complete');

  // ---- Case 4: simulate a v1->v3 Dexie upgrade path on the open DB ----
  // After imports, force-add a legacy-shaped row directly and re-run upgrade semantics
  // by deleting and reopening at an older schema is not possible on the same named DB;
  // instead verify the v3 index exists and queries work.
  const byUnderstudy = await db.roles.where('understudyOperatorId').equals('op-a').toArray();
  assert(byUnderstudy.some((r) => r.id === 'r3'), 'understudyOperatorId index queryable');
  const allRoles = await db.roles.toArray();
  assert(allRoles.every((r) => typeof r.understudyOn === 'boolean'), 'understudyOn is boolean on every row');

  await db.close();
  await new Promise((resolve) => { indexedDB.deleteDatabase('gbshadowplay').onsuccess = resolve; });

  // ---- Case 5: real upgrade from a v1 database (legacy rows without revision/understudy) ----
  await new Promise<void>((resolve, reject) => {
    const openReq = indexedDB.open('gbshadowplay', 1);
    openReq.onupgradeneeded = () => {
      const idb = openReq.result;
      const roleStore = idb.createObjectStore('roles', { keyPath: 'id' });
      roleStore.createIndex('sceneId', 'sceneId', { unique: false });
      idb.createObjectStore('operators', { keyPath: 'id' });
      idb.createObjectStore('plays', { keyPath: 'id' });
      idb.createObjectStore('scenes', { keyPath: 'id' });
      idb.createObjectStore('cues', { keyPath: 'id' });
    };
    openReq.onsuccess = () => {
      const idb = openReq.result;
      const tx = idb.transaction('roles', 'readwrite');
      tx.objectStore('roles').put({
        id: 'legacy-1', sceneId: 's1', name: '清代老角色', roleType: 'dan',
        propParts: [], entranceCue: '', lineNote: '', operatorId: null,
      });
      tx.oncomplete = () => {
        idb.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    openReq.onerror = () => reject(openReq.error);
  });

  // Reopen through the app's Dexie database class: upgrades 1 -> 2 -> 3 run in sequence
  await db.open();
  const upgraded = await db.roles.get('legacy-1');
  assert(!!upgraded, 'legacy v1 row survives upgrade');
  assert(upgraded?.understudyOperatorId === null, 'upgraded row defaults understudyOperatorId = null');
  assert(upgraded?.understudyOn === false, 'upgraded row defaults understudyOn = false');
  assert(upgraded?.revision === ROW_REVISION, `upgraded row revision = ${ROW_REVISION}`);
  assert(typeof upgraded?.createdAt === 'string', 'upgraded row backfills createdAt');

  await db.close();
  await new Promise((resolve) => { indexedDB.deleteDatabase('gbshadowplay').onsuccess = resolve; });
  console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL DATA-LAYER TESTS PASSED');
}

void main();
