/**
 * useUnderstudy(roles)
 * 角色替演师傅的指派校验与「接场 / 撤销接场」动作。
 *
 * 约定：
 * - 主操耍人 = role.operatorId；替演师傅 = role.understudyOperatorId
 * - understudyOn = true 表示当前正由替演接场（主次临时互换，可一键撤销）
 * - 同一场次已经在操耍其他角色的师傅不能当替演；接场前还要复查替演在本场
 *   是否还顶着另一个角色（主操或替演待场都算），撞上就说明演了谁并挡住，
 *   且不动主次关系。
 */
import { useCallback, useMemo } from 'react';
import { useOperatorStore } from '../stores/operatorStore';
import { db, listRolesByScene, putRoles, ROW_REVISION, type RoleRow } from '../utils/db';
import { nowIso } from '../utils/uuid';

/** 选替演时的校验结果 */
export interface UnderstudyEligibility {
  /** 可选为替演 */
  eligible: boolean;
  /** 不可选原因（eligible 为 false 时有值） */
  reason: string;
}

/** 接场前的复查结果 */
export interface TakeoverCheck {
  /** 可以接场 */
  allowed: boolean;
  /** 被挡住时的说明（演了谁） */
  reason: string;
  /** 撞场时替演正在操耍的同场角色 */
  conflictingRoles: RoleRow[];
}

/** 给定角色集合时，复查替演在本场是否还顶着另一个角色（纯函数） */
export function evaluateTakeover(
  role: RoleRow,
  sceneRoles: RoleRow[],
  operatorName: (id: string) => string,
): TakeoverCheck {
  const understudyId = role.understudyOperatorId;
  if (role.operatorId === null || understudyId === null) {
    return { allowed: false, reason: '该角色还没有定替演师傅', conflictingRoles: [] };
  }
  const conflicting = sceneRoles.filter(
    (item) =>
      item.id !== role.id &&
      (item.operatorId === understudyId || item.understudyOperatorId === understudyId),
  );
  if (conflicting.length > 0) {
    const names = conflicting
      .map((item) =>
        item.operatorId === understudyId ? `「${item.name}」` : `「${item.name}」（替演待场）`,
      )
      .join('、');
    return {
      allowed: false,
      reason: `${operatorName(understudyId)} 本场还演着 ${names}，无法分身接场，主次关系保持不变`,
      conflictingRoles: conflicting,
    };
  }
  return { allowed: true, reason: '', conflictingRoles: [] };
}

export interface UseUnderstudyResult {
  /** 评估某位师傅能否担任指定角色的替演 */
  assessUnderstudy: (role: RoleRow, operatorId: string) => UnderstudyEligibility;
  /** 接场前复查替演在本场是否另操耍角色 */
  checkTakeover: (role: RoleRow) => TakeoverCheck;
  /** 替演接场：主次互换并记录接场状态；被撞场挡住时返回原因 */
  handover: (role: RoleRow) => Promise<{ ok: boolean; reason: string }>;
  /** 撤销接场：主次两人回到接场前 */
  revert: (role: RoleRow) => Promise<void>;
}

export function useUnderstudy(roles: RoleRow[]): UseUnderstudyResult {
  const operators = useOperatorStore((state) => state.operators);

  /**
   * 同场中由某位师傅「正在操耍」的其他角色。
   * 接场互换后 operatorId 就是当前上场的师傅（主次两个 id 已对调），
   * 因此正在操耍人直接取 operatorId；understudyOn 仅用于界面与撤销还原。
   */
  const activeSameSceneRolesOf = useCallback(
    (operatorId: string, excludeRoleId: string): RoleRow[] =>
      roles.filter((role) => role.id !== excludeRoleId && role.operatorId === operatorId),
    [roles],
  );

  const assessUnderstudy = useCallback(
    (role: RoleRow, operatorId: string): UnderstudyEligibility => {
      if (role.operatorId === null) {
        return { eligible: false, reason: '请先指派主操耍人，再定替演师傅' };
      }
      if (operatorId === role.operatorId) {
        return { eligible: false, reason: '替演师傅不能与主操耍人是同一位' };
      }
      const occupied = activeSameSceneRolesOf(operatorId, role.id);
      if (occupied.length > 0) {
        const names = occupied.map((item) => `「${item.name}」`).join('、');
        const operatorName = operators.find((item) => item.id === operatorId)?.name ?? '该师傅';
        return {
          eligible: false,
          reason: `${operatorName} 同场已操耍 ${names}，不能再当替演`,
        };
      }
      return { eligible: true, reason: '' };
    },
    [operators, activeSameSceneRolesOf],
  );

  const operatorName = useCallback(
    (id: string): string => operators.find((item) => item.id === id)?.name ?? '替演师傅',
    [operators],
  );

  const checkTakeover = useCallback(
    (role: RoleRow): TakeoverCheck => evaluateTakeover(role, roles, operatorName),
    [operatorName, roles],
  );

  /** 落库一组角色并刷新操耍人档（assignedRoleIds 双向同步在各页面 reload 时完成） */
  const persist = useCallback(async (nextRows: RoleRow[]): Promise<void> => {
    const stamp = nowIso();
    await putRoles(nextRows.map((row) => ({ ...row, updatedAt: stamp, revision: ROW_REVISION })));
  }, []);

  const handover = useCallback(
    async (role: RoleRow): Promise<{ ok: boolean; reason: string }> => {
      // 以数据库里的最新状态再复查一遍，避免页面状态滞后导致误接场
      const fresh = await db.roles.get(role.id);
      if (!fresh || fresh.operatorId === null || fresh.understudyOperatorId === null) {
        return { ok: false, reason: '该角色还没有定替演师傅' };
      }
      if (fresh.understudyOn === true) {
        return { ok: false, reason: '替演已经在场上，无需重复接场' };
      }
      const sceneRoles = await listRolesByScene(fresh.sceneId);
      const check = evaluateTakeover(fresh, sceneRoles, operatorName);
      if (!check.allowed) return { ok: false, reason: check.reason };

      const primaryId: string = fresh.operatorId;
      const understudyId: string = fresh.understudyOperatorId;
      // 主次互换：替演成为当前操耍人，原主操人自动转为替演，并标记接场状态
      const swapped: RoleRow = {
        ...fresh,
        operatorId: understudyId,
        understudyOperatorId: primaryId,
        understudyOn: true,
      };
      await persist([swapped]);
      return { ok: true, reason: '' };
    },
    [operatorName, persist],
  );

  const revert = useCallback(
    async (role: RoleRow): Promise<void> => {
      const fresh = await db.roles.get(role.id);
      if (!fresh || fresh.understudyOn !== true || fresh.understudyOperatorId === null || fresh.operatorId === null) {
        return;
      }
      // 撤销接场：主次两人回到接场前
      const restored: RoleRow = {
        ...fresh,
        operatorId: fresh.understudyOperatorId,
        understudyOperatorId: fresh.operatorId,
        understudyOn: false,
      };
      await persist([restored]);
    },
    [persist],
  );

  return useMemo(
    () => ({ assessUnderstudy, checkTakeover, handover, revert }),
    [assessUnderstudy, checkTakeover, handover, revert],
  );
}
