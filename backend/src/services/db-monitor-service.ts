// ============================================================
// DB Monitor Service
// Local client DB2 configuration overview (SQLite metadata only).
// Live batch/queue monitoring uses JDBC via db2-direct-service.ts.
// ============================================================

import { config } from '../config';
import { prisma } from '../database/prisma';
import { keeperService } from './keeper-service';

class DBMonitorService {
  /** Overview of all clients with their DB2 configuration status. */
  async getClientsDBStatus(): Promise<Array<{
    id: string;
    clientId: string;
    name: string;
    cluster: string;
    db2Configured: boolean;
    db2Host: string | null;
    db2Database: string | null;
    db2Schema: string | null;
    hasCredentials: boolean;
    serverCount: number;
  }>> {
    const clients = await prisma.client.findMany({
      where: { isActive: true },
      include: {
        appServers: { where: { environment: 'Prod', isActive: true }, select: { id: true } },
      },
      orderBy: { clientId: 'asc' },
    });

    return clients.map(c => ({
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      cluster: c.cluster,
      db2Configured: !!(c.db2Host && c.db2Database),
      db2Host: c.db2Host,
      db2Database: c.db2Database,
      db2Schema: c.db2Schema,
      hasCredentials: keeperService.isConfigured() || !!(config.keeper.db2Username && config.keeper.db2Password),
      serverCount: c.appServers.length,
    }));
  }
}

export const dbMonitorService = new DBMonitorService();
