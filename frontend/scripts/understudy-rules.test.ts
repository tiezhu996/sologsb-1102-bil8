/**
 * 替演业务规则校验（无浏览器依赖）。
 * 运行：npx esbuild scripts/understudy-rules.test.ts --bundle --platform=node \
 *        --format=esm --outfile=/tmp/t.mjs && node /tmp/t.mjs
 */
import { evaluateTakeover } from '../src/hooks/useUnderstudy';
import type { OperatorRow, RoleRow } from '../src/utils/db';

function assert(cond: boolean, label: string): void {
  if (cond) console.log(`PASS ${label}`);
  else {
    console.error(`FAIL ${label}`);
    process.exitCode = 1;
  }
}

const stamp = '2026-09-28T00:00:00.000Z';
const operator = (id: string, name: string): OperatorRow => ({
  id, name, skillTags: [], busySlots: [], assignedRoleIds: [], rehearsalHours: 0,
  createdAt: stamp, updatedAt: stamp, revision: 3,
});
const role = (
  id: string,
  name: string,
  operatorId: string | null,
  understudyOperatorId: string | null = null,
  understudyOn = false,
): RoleRow => ({
  id, sceneId: 'scene-1', name, roleType: 'sheng', propParts: [],
  entranceCue: '', lineNote: '', operatorId, understudyOperatorId, understudyOn,
  createdAt: stamp, updatedAt: stamp, revision: 3,
});

/** 与 useUnderstudy.assessUnderstudy 相同的选替演判定（不涉存储） */
function assessUnderstudy(
  r: RoleRow,
  candidateId: string,
  sceneRoles: RoleRow[],
  nameOf: (id: string) => string,
): { eligible: boolean; reason: string } {
  if (r.operatorId === null) return { eligible: false, reason: '请先指派主操耍人，再定替演师傅' };
  if (candidateId === r.operatorId) return { eligible: false, reason: '替演师傅不能与主操耍人是同一位' };
  const occupied = sceneRoles.filter(
    (item) => item.id !== r.id && item.operatorId === candidateId,
  );
  if (occupied.length > 0) {
    return {
      eligible: false,
      reason: `${nameOf(candidateId)} 同场已操耍 ${occupied.map((i) => `「${i.name}」`).join('、')}，不能再当替演`,
    };
  }
  return { eligible: true, reason: '' };
}

const [A, B, C] = [operator('a', '霍连生'), operator('b', '苗凤仪'), operator('c', '裴三保')];
const nameOf = (id: string): string => [A, B, C].find((o) => o.id === id)?.name ?? '该师傅';

// 场景一：选替演
let roles = [role('r1', '白娘子', A.id, C.id), role('r2', '许仙', B.id)];
assert(assessUnderstudy(roles[0], B.id, roles, nameOf).eligible === false, '同场主操别的角色者不可选为替演');
assert(
  assessUnderstudy(roles[0], B.id, roles, nameOf).reason.includes('许仙'),
  '拦截原因说明该师傅演了「许仙」',
);
assert(assessUnderstudy(roles[0], A.id, roles, nameOf).eligible === false, '主操耍人本人不能当自己的替演');
assert(assessUnderstudy(roles[0], C.id, roles, nameOf).eligible === true, '空闲师傅可当替演');
assert(
  assessUnderstudy(role('r9', '无主', null), C.id, roles, nameOf).eligible === false,
  '没有主操耍人时不能定替演',
);

// 场景二：接场前复查——替演在同场还顶着另一个角色名分（待场替演 / 主操）
roles = [role('r1', '白娘子', A.id, C.id), role('r2', '许仙', B.id, C.id)];
const blockedStandby = evaluateTakeover(roles[0], roles, nameOf);
assert(blockedStandby.allowed === false, '替演另当同场角色待场替演时接场被挡住');
assert(blockedStandby.reason.includes('许仙'), '挡住时说明替演演了「许仙」');
assert(roles[0].operatorId === A.id && roles[0].understudyOperatorId === C.id, '挡住后主次关系不变');

roles = [role('r1', '白娘子', A.id, C.id), role('r2', '许仙', C.id)];
const blockedPrimary = evaluateTakeover(roles[0], roles, nameOf);
assert(blockedPrimary.allowed === false, '替演主操同场另一角色时接场被挡住');
assert(blockedPrimary.reason.includes('许仙'), '挡住说明里点出「许仙」');
assert(!blockedPrimary.reason.includes('替演待场'), '主操身份不标注替演待场');
assert(roles[0].operatorId === A.id && roles[0].understudyOperatorId === C.id, '复查不修改主次数据');

// 场景三：正常接场 -> 主次互换；撤销 -> 回到接场前
roles = [role('r1', '白娘子', A.id, C.id), role('r2', '许仙', B.id)];
assert(evaluateTakeover(roles[0], roles, nameOf).allowed === true, '替演空闲时接场放行');
const onStage: RoleRow = { ...roles[0], operatorId: C.id, understudyOperatorId: A.id, understudyOn: true };
assert(onStage.operatorId === C.id, '接场后替演成为当前操耍人');
assert(onStage.understudyOperatorId === A.id, '接场后原主操人自动转为替演');
assert(onStage.understudyOn === true, '接场状态已标记');
const reverted: RoleRow = {
  ...onStage,
  operatorId: onStage.understudyOperatorId,
  understudyOperatorId: onStage.operatorId,
  understudyOn: false,
};
assert(reverted.operatorId === A.id, '撤销后原主操人回到操耍位');
assert(reverted.understudyOperatorId === C.id, '撤销后替演回到待场位');
assert(reverted.understudyOn === false, '撤销后接场标记清除');

// 场景四：接场状态会改变同场占用——正在接场（operatorId 已换成替演）者计入占用；
// 已转为待场替演的原主操人此刻不在操耍，可选为别的角色的替演
roles = [role('r1', '白娘子', C.id, A.id, true), role('r2', '许仙', B.id)];
assert(
  assessUnderstudy(roles[1], C.id, roles, nameOf).eligible === false,
  '接场中的替演按实际操耍人计入同场占用',
);
assert(
  assessUnderstudy(roles[1], C.id, roles, nameOf).reason.includes('白娘子'),
  '占用原因点出正在接场的「白娘子」',
);
// 注：A 虽是白娘子的待场替演，选替演只看当前操耍，故可选；真正接场时再由复查拦截
assert(assessUnderstudy(roles[1], A.id, roles, nameOf).eligible === true, '未在操耍的待场替演可选为替演');

// 场景五：待场替演还顶着另一角色名分，接场复查挡住
roles = [role('r1', '白娘子', C.id, A.id, true), role('r2', '许仙', B.id, A.id)];
const aBlocked = evaluateTakeover(roles[1], roles, nameOf);
assert(aBlocked.allowed === false, '待场替演还顶着另一角色名分，接场被复查挡住');
assert(aBlocked.reason.includes('白娘子'), '挡住说明点出还演着「白娘子」');
assert(roles[1].operatorId === B.id && roles[1].understudyOperatorId === A.id, '复查挡住不动许仙的主次');

// 场景六：未定替演不能接场
assert(
  evaluateTakeover(role('r0', '无替演', A.id), roles, nameOf).allowed === false,
  '未定替演的角色接场被拒',
);

console.log(process.exitCode ? 'SOME TESTS FAILED' : 'ALL UNDERSTUDY-RULE TESTS PASSED');
