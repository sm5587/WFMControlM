import { ensureHeatMapPermissions } from '../../src/services/rbac-bootstrap';

jest.mock('../../src/database/prisma', () => ({
  prisma: {
    profile: { findMany: jest.fn() },
    permission: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    appFunction: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { prisma } from '../../src/database/prisma';

const mockedPrisma = prisma as unknown as {
  profile: { findMany: jest.Mock };
  permission: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    upsert: jest.Mock;
    deleteMany: jest.Mock;
  };
  appFunction: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    delete: jest.Mock;
  };
};

describe('ensureHeatMapPermissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrisma.appFunction.findUnique.mockResolvedValue(null);
  });

  it('creates missing system-profile permissions and skips existing ones', async () => {
    mockedPrisma.profile.findMany.mockResolvedValue([
      { id: 'admin', name: 'System Admin' },
      { id: 'mon', name: 'Monitor' },
    ]);
    mockedPrisma.permission.findUnique
      .mockResolvedValueOnce(null) // admin missing
      .mockResolvedValueOnce({ profileId: 'mon', functionId: 'HEATMAP_VIEW' }) // mon exists
      .mockResolvedValueOnce(null); // custom profile missing
    mockedPrisma.permission.findMany.mockResolvedValue([{ profileId: 'custom' }]);
    mockedPrisma.permission.create.mockResolvedValue({});

    await ensureHeatMapPermissions();

    expect(mockedPrisma.permission.create).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.permission.create).toHaveBeenCalledWith({
      data: {
        profileId: 'admin',
        functionId: 'HEATMAP_VIEW',
        canRead: true,
        canWrite: true,
      },
    });
    expect(mockedPrisma.permission.create).toHaveBeenCalledWith({
      data: {
        profileId: 'custom',
        functionId: 'HEATMAP_VIEW',
        canRead: true,
        canWrite: false,
      },
    });
  });
});
