/**
 * The permission catalogue and the built-in roles. Authorization is permission-based: every route in `routes/spec.ts` names the one permission it needs and
 * `authenticate()` enforces it centrally, so a route cannot be added without an authorization decision (a test fails for any row without one). Roles are just named
 * sets of permissions: four built-in ones (code, not database rows, so they cannot drift or be edited) and custom roles per workspace (`roles` table).
 */
export const PERMISSIONS = {
  'funnels:read': 'View funnels, steps, pages, history, previews and templates',
  'funnels:write': 'Create and edit funnels, steps and pages; use templates; duplicate; restore page versions',
  'funnels:delete': 'Move funnels to the trash and restore them',
  'funnels:purge': 'Permanently delete a trashed funnel',
  'funnels:tracking': 'Edit custom header/footer tracking code on funnels and steps',
  'tags:manage': 'Create, rename and delete tags',
  'blocks:manage': 'Save and delete custom blocks',
  'leads:read': 'View leads',
  'leads:export': 'Export leads as CSV',
  'orders:read': 'View orders',
  'orders:export': 'Export orders as CSV',
  'orders:refund': 'Refund orders (full or partial)',
  'analytics:read': 'View funnel and step analytics',
  'analytics:export': 'Create API keys with the export scope and read the raw analytics exports (with analytics_identity:manage: the identity pepper)',
  'ai:use': 'Use the AI assistant',
  'domains:read': 'View domains and DNS instructions',
  'domains:manage': 'Add, verify, configure and delete domains',
  'webhooks:manage': 'Manage webhooks and their delivery log',
  'members:read': 'View members, invitations and roles',
  'members:manage': 'Invite, remove and change the role of members',
  'roles:manage': 'Create, edit and delete custom roles',
  'workspace:manage': 'Rename the workspace and change workspace-wide settings',
  'audit:read': 'View the audit log',
  'api_keys:manage': 'Create and revoke API keys',
  'analytics_identity:manage': 'View and rotate the workspace identity pepper used by analytics exports',
  'billing:read': 'View the plan, usage and invoices',
  'billing:manage': 'Change the plan, payment method and Stripe connection',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
export const isPermission = (p: string): p is Permission => Object.prototype.hasOwnProperty.call(PERMISSIONS, p);

export type SystemRoleId = 'owner' | 'admin' | 'member' | 'viewer';

export interface RoleDef {
  id: string;
  name: string;
  description: string;
  system: boolean;
  permissions: Permission[];
}

const without = (drop: Permission[]): Permission[] => ALL_PERMISSIONS.filter((p) => !drop.includes(p));

export const SYSTEM_ROLES: Record<SystemRoleId, RoleDef> = {
  owner: { id: 'owner', name: 'Owner', description: 'Everything, including billing, roles and permanently deleting funnels. Every workspace keeps at least one.', system: true, permissions: [...ALL_PERMISSIONS] },
  admin: {
    id: 'admin', name: 'Admin', description: 'Everything except billing, workspace settings, member and role management and permanent deletion.', system: true,
    permissions: without(['billing:manage', 'workspace:manage', 'members:manage', 'roles:manage', 'funnels:purge', 'analytics_identity:manage']),
  },
  member: {
    id: 'member', name: 'Member', description: 'Builds and edits funnels, reads leads, orders and analytics, uses AI. Cannot delete funnels, manage domains, webhooks or people.', system: true,
    permissions: ['funnels:read', 'funnels:write', 'tags:manage', 'blocks:manage', 'leads:read', 'leads:export', 'orders:read', 'orders:export', 'analytics:read', 'ai:use', 'domains:read', 'members:read'],
  },
  viewer: { id: 'viewer', name: 'Viewer', description: 'Read-only access to funnels, leads, orders, analytics and domains.', system: true, permissions: ['funnels:read', 'leads:read', 'orders:read', 'analytics:read', 'domains:read', 'members:read'] },
};

export const isSystemRoleId = (id: string): id is SystemRoleId => Object.prototype.hasOwnProperty.call(SYSTEM_ROLES, id);
