// ============================================================
// WebSocket Server - Real-time event broadcasting
// ============================================================

import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { createServiceLogger } from '../utils/logger';
import { configService } from '../services/config-service';
import { hasPermission } from '../middleware';
import { jobExecutor } from '../engine/executor';
import { alertService } from '../services/alert-service';
import { monitoringService } from '../services/monitoring-service';
import {
  getSocketUser,
  isValidExecutionId,
  joinPermissionStreams,
  socketAuthMiddleware,
  WS_STREAM_ROOMS,
} from './auth';

const logger = createServiceLogger('WebSocket');

let io: SocketServer | null = null;

export function initializeWebSocket(httpServer: HttpServer): SocketServer {
  const corsOrigins = configService.getString('infra.corsOrigins')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  io = new SocketServer(httpServer, {
    cors: {
      origin: corsOrigins.length > 0 ? corsOrigins : ['http://localhost:3005'],
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.use(socketAuthMiddleware);

  io.on('connection', (socket: Socket) => {
    const user = getSocketUser(socket);
    if (!user) {
      socket.disconnect(true);
      return;
    }

    joinPermissionStreams(socket, user);
    logger.info(`Client connected: ${socket.id} (${user.username})`);

    socket.on('subscribe', (room: string) => {
      if (typeof room !== 'string' || !room.startsWith('stream:')) {
        logger.warn(`Client ${socket.id} rejected subscribe to room: ${room}`);
        return;
      }
      if (room === WS_STREAM_ROOMS.execution && !hasPermission(user, 'MONITOR_VIEW', 'read')) return;
      if (room === WS_STREAM_ROOMS.alerts && !hasPermission(user, 'ALERTS_VIEW', 'read')) return;
      socket.join(room);
      logger.debug(`Client ${socket.id} subscribed to: ${room}`);
    });

    socket.on('unsubscribe', (room: string) => {
      if (typeof room !== 'string') return;
      socket.leave(room);
      logger.debug(`Client ${socket.id} unsubscribed from: ${room}`);
    });

    socket.on('dashboard:refresh', async () => {
      try {
        const stats = await monitoringService.getDashboardStats();
        socket.emit('dashboard:update', wrapEvent('dashboard:update', stats));
      } catch (error: any) {
        logger.error(`Dashboard refresh error: ${error.message}`);
      }
    });

    socket.on('execution:follow', (executionId: string) => {
      if (!hasPermission(user, 'MONITOR_VIEW', 'read')) {
        logger.warn(`Client ${socket.id} denied execution:follow — missing MONITOR_VIEW`);
        return;
      }
      if (!isValidExecutionId(executionId)) {
        logger.warn(`Client ${socket.id} rejected invalid execution id`);
        return;
      }
      socket.join(`execution:${executionId}`);
      logger.debug(`Client ${socket.id} following execution: ${executionId}`);
    });

    socket.on('execution:unfollow', (executionId: string) => {
      if (!isValidExecutionId(executionId)) return;
      socket.leave(`execution:${executionId}`);
    });

    socket.on('disconnect', () => {
      logger.debug(`Client disconnected: ${socket.id}`);
    });
  });

  // ---- Wire up event listeners ----

  jobExecutor.on('execution:started', (data) => {
    broadcastToRoom(WS_STREAM_ROOMS.execution, 'execution:started', data);
    broadcastToRoom(`execution:${data.executionId}`, 'execution:started', data);
  });

  jobExecutor.on('execution:progress', (data) => {
    broadcastToRoom(`execution:${data.executionId}`, 'execution:progress', data);
  });

  jobExecutor.on('execution:completed', (data) => {
    broadcastToRoom(WS_STREAM_ROOMS.execution, 'execution:completed', data);
    broadcastToRoom(`execution:${data.executionId}`, 'execution:completed', data);
    broadcastDashboardUpdate();
  });

  jobExecutor.on('execution:failed', (data) => {
    broadcastToRoom(WS_STREAM_ROOMS.execution, 'execution:failed', data);
    broadcastToRoom(`execution:${data.executionId}`, 'execution:failed', data);
    broadcastDashboardUpdate();
  });

  alertService.on('alert:new', (data) => {
    broadcastToRoom(WS_STREAM_ROOMS.alerts, 'alert:triggered', data);
  });

  logger.info('WebSocket server initialized');
  return io;
}

function wrapEvent(event: string, data: any) {
  return {
    type: event,
    payload: data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Broadcast to a specific room
 */
function broadcastToRoom(room: string, event: string, data: any): void {
  if (io) {
    io.to(room).emit(event, wrapEvent(event, data));
  }
}

/**
 * Broadcast dashboard update (debounced)
 */
let dashboardUpdateTimeout: NodeJS.Timeout | null = null;
async function broadcastDashboardUpdate(): Promise<void> {
  if (dashboardUpdateTimeout) {
    clearTimeout(dashboardUpdateTimeout);
  }
  dashboardUpdateTimeout = setTimeout(async () => {
    try {
      const stats = await monitoringService.getDashboardStats();
      broadcastToRoom(WS_STREAM_ROOMS.dashboard, 'dashboard:update', stats);
    } catch (error: any) {
      logger.error(`Dashboard broadcast error: ${error.message}`);
    }
  }, 1000);
}

export function getIO(): SocketServer | null {
  return io;
}
