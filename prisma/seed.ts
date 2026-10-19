import type { Permission } from '../src/generated/prisma/client';
import { logger, serializeError } from '../src/lib/logger';
import { prisma } from '../src/lib/prisma';
import { AGENT_SYSTEM_PROMPT, RAG_SYSTEM_PROMPT } from '../src/config/prompts';

async function seedRBAC() {
  // Define permissions
  const permissionDefs = [
    {
      name: 'documents:create',
      resource: 'documents',
      action: 'create',
      description: 'Upload documents',
    },
    { name: 'documents:read', resource: 'documents', action: 'read', description: 'View documents' },
    {
      name: 'documents:update',
      resource: 'documents',
      action: 'update',
      description: 'Edit document metadata',
    },
    {
      name: 'documents:delete',
      resource: 'documents',
      action: 'delete',
      description: 'Delete documents',
    },
    {
      name: 'conversations:create',
      resource: 'conversations',
      action: 'create',
      description: 'Start conversations',
    },
    {
      name: 'conversations:read',
      resource: 'conversations',
      action: 'read',
      description: 'View conversations',
    },
    { name: 'users:read', resource: 'users', action: 'read', description: 'View user list' },
    {
      name: 'users:manage',
      resource: 'users',
      action: 'manage',
      description: 'Manage user accounts',
    },
    {
      name: 'roles:manage',
      resource: 'roles',
      action: 'manage',
      description: 'Manage roles and permissions',
    },
  ];

  // Upsert all permissions
  const permissions: Record<string, Permission> = {};
  for (const perm of permissionDefs) {
    permissions[perm.name] = await prisma.permission.upsert({
      where: { name: perm.name },
      update: {},
      create: perm,
    });
  }

  // Define roles with their permissions
  const roleDefs = [
    {
      name: 'admin',
      description: 'Full system access',
      permissions: Object.keys(permissions), // All permissions
    },
    {
      name: 'member',
      description: 'Standard user',
      isDefault: true,
      permissions: [
        'documents:create',
        'documents:read',
        'documents:update',
        'conversations:create',
        'conversations:read',
      ],
    },
    {
      name: 'viewer',
      description: 'Read-only access',
      permissions: ['documents:read', 'conversations:read'],
    },
  ];

  for (const roleDef of roleDefs) {
    const role = await prisma.role.upsert({
      where: { name: roleDef.name },
      update: {},
      create: {
        name: roleDef.name,
        description: roleDef.description,
        isDefault: roleDef.isDefault ?? false,
      },
    });

    // Link permissions to role
    for (const permName of roleDef.permissions) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permissions[permName]!.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permissions[permName]!.id,
        },
      });
    }
  }

  logger.info('RBAC seeded', { roles: 3, permissions: 9 });
}

// From your current prompts.ts
async function seedPromptTemplates() {
  await prisma.promptTemplate.upsert({
    where: { taskType_version: { taskType: 'chat', version: 'v1' } },
    update: {},
    create: {
      taskType: 'chat',
      version: 'v1',
      name: 'RAG Chat - Initial',
      content: RAG_SYSTEM_PROMPT,
      isActive: true,
    },
  });

  await prisma.promptTemplate.upsert({
    where: { taskType_version: { taskType: 'agent', version: 'v1' } },
    update: {},
    create: {
      taskType: 'agent',
      version: 'v1',
      name: 'Research Agent - Initial',
      content: AGENT_SYSTEM_PROMPT,
      isActive: true,
    },
  });

  logger.info('Prompt templates seeded', { templates: 2 });
}

async function main() {
  await seedRBAC();
  await seedPromptTemplates();
}

main()
  .catch((error) => {
    logger.error('Seed failed', { error: serializeError(error) });
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
