import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import { ALL_PERMISSIONS, isPermission, isSystemRoleId, PERMISSIONS, SYSTEM_ROLES, type Permission, type RoleDef } from '../auth/permissions.js';
import type { Deps } from '../deps.js';
import { isUniqueViolation } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';

export const RoleInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
  permissions: z.array(z.string()).max(ALL_PERMISSIONS.length),
});
export const RolePatch = RoleInput.partial();


interface RoleRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  permissions_json: string;
  created_at: string;
  updated_at: string;
}

const shape = (r: RoleDef, extra: { members?: number } = {}) => ({ id: r.id, name: r.name, description: r.description, system: r.system, permissions: [...r.permissions].sort(), ...extra });
const fromRow = (r: RoleRow): RoleDef => ({ id: r.id, name: r.name, description: r.description, system: false, permissions: (JSON.parse(r.permissions_json) as string[]).filter(isPermission) });

export const permissionCatalogue = () => ({ data: ALL_PERMISSIONS.map((id) => ({ id, description: PERMISSIONS[id] })) });

/** Built-in roles first, then the workspace's custom roles, each with how many members hold it. */
export async function listRoles(deps: Deps, ws: string) {
  const custom = (await deps.db.all<RoleRow>('SELECT * FROM roles WHERE workspace_id = ? ORDER BY name, id', ws)).map(fromRow);
  const counts = new Map((await deps.db.all<{ role_id: string; n: number }>('SELECT COALESCE(role_id, role) AS role_id, COUNT(*) AS n FROM users WHERE workspace_id = ? GROUP BY COALESCE(role_id, role)', ws)).map((r) => [r.role_id, Number(r.n)]));
  return { data: [...Object.values(SYSTEM_ROLES), ...custom].map((r) => shape(r, { members: counts.get(r.id) ?? 0 })) };
}

/** A role by id within a workspace (built-in or custom); undefined when it does not exist there. */
export async function findRole(deps: Deps, ws: string, id: string): Promise<RoleDef | undefined> {
  if (isSystemRoleId(id)) return SYSTEM_ROLES[id];
  const row = await deps.db.get<RoleRow>('SELECT * FROM roles WHERE workspace_id = ? AND id = ?', ws, id);
  return row ? fromRow(row) : undefined;
}

/**
 * Nobody can hand out more than they have: the permissions of the role being created, edited or assigned must all be held by the actor. Without this a holder of
 * `roles:manage` or `members:manage` could mint themselves (or a friend) an owner-equivalent role.
 */
export function assertCanGrant(auth: Auth, permissions: Iterable<Permission>): void {
  const beyond = [...permissions].filter((p) => !auth.permissions.has(p));
  if (beyond.length) throw forbidden(`You cannot grant permissions you do not have yourself: ${beyond.slice(0, 5).join(', ')}${beyond.length > 5 ? ', ...' : ''}`);
}

function parsePermissions(list: string[]): Permission[] {
  const bad = list.filter((p) => !isPermission(p));
  if (bad.length) throw badRequest('UNKNOWN_PERMISSION', `Unknown permission: ${bad.slice(0, 3).join(', ')}`);
  return [...new Set(list)] as Permission[];
}

const reservedName = (name: string) => Object.values(SYSTEM_ROLES).some((r) => r.name.toLowerCase() === name.toLowerCase());

export async function createRole(deps: Deps, auth: Auth, input: z.infer<typeof RoleInput>, ip?: string) {
  const permissions = parsePermissions(input.permissions);
  assertCanGrant(auth, permissions);
  if (reservedName(input.name)) throw conflict('ROLE_NAME_TAKEN', 'That name is used by a built-in role');
  const n = Number((await deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM roles WHERE workspace_id = ?', auth.workspaceId))!.n);
  if (n >= deps.config.MAX_CUSTOM_ROLES) throw conflict('ROLE_LIMIT', `A workspace can have at most ${deps.config.MAX_CUSTOM_ROLES} custom roles`);
  const id = newId('rol');
  const at = deps.now().toISOString();
  try {
    await deps.db.run('INSERT INTO roles (id, workspace_id, name, description, permissions_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, auth.workspaceId, input.name, input.description, JSON.stringify(permissions), auth.userId, at, at);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('ROLE_NAME_TAKEN', 'A role with this name already exists');
    throw e;
  }
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'role.created', target: id, detail: { name: input.name, permissions }, ip });
  return shape({ id, name: input.name, description: input.description, system: false, permissions });
}

export async function updateRole(deps: Deps, auth: Auth, id: string, patch: z.infer<typeof RolePatch>, ip?: string) {
  if (isSystemRoleId(id)) throw forbidden('Built-in roles cannot be edited; create a custom role instead');
  const row = await deps.db.get<RoleRow>('SELECT * FROM roles WHERE workspace_id = ? AND id = ?', auth.workspaceId, id);
  if (!row) throw notFound('Role');
  const before = fromRow(row);
  const permissions = patch.permissions ? parsePermissions(patch.permissions) : before.permissions;
  // Editing a role changes what its holders can do, so the editor must hold everything the role has now AND everything it will have.
  assertCanGrant(auth, [...before.permissions, ...permissions]);
  const name = patch.name ?? before.name;
  if (name.toLowerCase() !== before.name.toLowerCase() && reservedName(name)) throw conflict('ROLE_NAME_TAKEN', 'That name is used by a built-in role');
  try {
    await deps.db.run('UPDATE roles SET name = ?, description = ?, permissions_json = ?, updated_at = ? WHERE id = ?', name, patch.description ?? before.description, JSON.stringify(permissions), deps.now().toISOString(), id);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('ROLE_NAME_TAKEN', 'A role with this name already exists');
    throw e;
  }
  const added = permissions.filter((p) => !before.permissions.includes(p));
  const removed = before.permissions.filter((p) => !permissions.includes(p));
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'role.updated', target: id, detail: { name, added, removed }, ip });
  return shape({ id, name, description: patch.description ?? before.description, system: false, permissions });
}

export async function deleteRole(deps: Deps, auth: Auth, id: string, ip?: string): Promise<void> {
  if (isSystemRoleId(id)) throw forbidden('Built-in roles cannot be deleted');
  const row = await deps.db.get<RoleRow>('SELECT * FROM roles WHERE workspace_id = ? AND id = ?', auth.workspaceId, id);
  if (!row) throw notFound('Role');
  const used = Number((await deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE workspace_id = ? AND role_id = ?', auth.workspaceId, id))!.n)
    + Number((await deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invitations WHERE workspace_id = ? AND role_id = ? AND accepted_at IS NULL AND revoked_at IS NULL', auth.workspaceId, id))!.n);
  if (used > 0) throw conflict('ROLE_IN_USE', `${used} member(s) or pending invitation(s) still use this role; move them to another role first`);
  assertCanGrant(auth, fromRow(row).permissions);
  await deps.db.run('DELETE FROM roles WHERE id = ?', id);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'role.deleted', target: id, detail: { name: row.name }, ip });
}
