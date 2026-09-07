// ============================================================
// Unit tests: access-request-service — LDAP registration queue
// ============================================================

jest.mock('../../src/utils/logger', () => ({
  createServiceLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../src/config', () => ({
  config: {
    sso: { allowedDomain: 'zebra.com' },
  },
}));

const mockAccessRequestFindUnique = jest.fn();
const mockAccessRequestCreate = jest.fn();
const mockAccessRequestUpdate = jest.fn();
const mockUserFindUnique = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  prisma: {
    accessRequest: {
      findUnique: (...args: unknown[]) => mockAccessRequestFindUnique(...args),
      create: (...args: unknown[]) => mockAccessRequestCreate(...args),
      update: (...args: unknown[]) => mockAccessRequestUpdate(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
  },
}));

import { resolveLdapAccessStatus, resolveAccessRequestStatus } from '../../src/services/access-request-service';

describe('access-request-service — LDAP flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindUnique.mockResolvedValue(null);
  });

  it('creates a pending access request with LDAP identity fields', async () => {
    mockAccessRequestFindUnique.mockResolvedValue(null);
    mockAccessRequestCreate.mockResolvedValue({
      id: 'req-1',
      email: 'jdoe@zebra.com',
      displayName: 'John Doe',
      requestedUsername: 'jdoe',
      status: 'PENDING',
    });

    const status = await resolveLdapAccessStatus('jdoe@zebra.com', '10.0.0.1', {
      displayName: 'John Doe',
      requestedUsername: 'jdoe',
    });

    expect(mockAccessRequestCreate).toHaveBeenCalledWith({
      data: {
        email: 'jdoe@zebra.com',
        sourceIp: '10.0.0.1',
        status: 'PENDING',
        displayName: 'John Doe',
        requestedUsername: 'jdoe',
      },
    });
    expect(status.status).toBe('PENDING');
    expect(status.canLogin).toBe(false);
    expect(status.email).toBe('jdoe@zebra.com');
  });

  it('rejects emails outside the allowed domain', async () => {
    const status = await resolveAccessRequestStatus('jdoe@example.com', '10.0.0.1', {
      displayName: 'John Doe',
      requestedUsername: 'jdoe',
    });

    expect(status.status).toBe('DOMAIN_DENIED');
    expect(mockAccessRequestCreate).not.toHaveBeenCalled();
  });

  it('returns ACTIVE without canLogin when user exists but has no profiles', async () => {
    mockUserFindUnique.mockResolvedValue({
      id: 'user-1',
      email: 'jdoe@zebra.com',
      displayName: 'John Doe',
      isActive: true,
      profiles: [],
    });

    const status = await resolveLdapAccessStatus('jdoe@zebra.com');

    expect(status.status).toBe('ACTIVE');
    expect(status.canLogin).toBe(false);
    expect(status.message).toMatch(/no profile/i);
  });
});
