// ============================================================
// WebSocket Server - Real-time event broadcasting
// ============================================================

import { Server as HttpServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { createServiceLogger } from '../utils/logger';
import { jobExecutor } from '../engine/executor';
import { alertService } from '../services/alert-service';
import { monitoringService } from '../services/monitoring-service';

const logger = createServiceLogger('WebSocket');

let io: SocketServer | null = null;

export function initializeWebSocket(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: ['http://localhost:3000', 'http://localhost:5173'],
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on('connection', (socket: Socket) => {
    logger.info(`Client connected: ${socket.id}`);

    // Join rooms based on subscriptions
    socket.on('subscribe', (room: string) => {
      socket.join(room);
      logger.debug(`Client ${socket.id} subscribed to: ${room}`);
    });

    socket.on('unsubscribe', (room: string) => {
      socket.leave(room);
      logger.debug(`Client ${socket.id} unsubscribed from: ${room}`);
    });

    // Handle dashboard data request
    socket.on('dashboard:refresh', async () => {
      try {
        const stats = await monitoringService.getDashboardStats();
        socket.emit('dashboard:update', stats);
      } catch (error: any) {
        logger.error(`Dashboard refresh error: ${error.message}`);
      }
    });

    // Handle execution log streaming
    socket.on('execution:follow', (executionId: string) => {
      socket.join(`execution:${executionId}`);
      logger.debug(`Client ${socket.id} following execution: ${executionId}`);
    });

    socket.on('execution:unfollow', (executionId: string) => {
      socket.leave(`execution:${executionId}`);
    });

    socket.on('disconnect', () => {
      logger.debug(`Client disconnected: ${socket.id}`);
    });
  });

  // ---- Wire up event listeners ----

  // Job execution events
  jobExecutor.on('execution:started', (data) => {
    broadcast('execution:started', data);
    broadcastToRoom(`execution:${data.executionId}`, 'execution:started', data);
  });

  jobExecutor.on('execution:progress', (data) => {
    broadcastToRoom(`execution:${data.executionId}`, 'execution:progress', data);
  });

  jobExecutor.on('execution:completed', (data) => {
    broadcast('execution:completed', data);
    broadcastToRoom(`execution:${data.executionId}`, 'execution:completed', data);
    broadcastDashboardUpdate();
  });

  jobExecutor.on('execution:failed', (data) => {
    broadcast('execution:failed', data);
    broadcastToRoom(`execution:${data.executionId}`, 'execution:failed', data);
    broadcastDashboardUpdate();
  });

  // Alert events
  alertService.on('alert:new', (data) => {
    broadcast('alert:triggered', data);
  });

  logger.info('WebSocket server initialized');
  return io;
}

/**
 * Broadcast to all connected clients
 */
function broadcast(event: string, data: any): void {
  if (io) {
    io.emit(event, {
      type: event,
      payload: data,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Broadcast to a specific room
 */
function broadcastToRoom(room: string, event: string, data: any): void {
  if (io) {
    io.to(room).emit(event, {
      type: event,
      payload: data,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Broadcast dashboard update (debounced)
 */
let dashboardUpdateTimeout: NodeJS.Timeout | null = null;
async function broadcastDashboardUpdate(): Promise<void> {
  // Debounce dashboard updates to avoid flooding
  if (dashboardUpdateTimeout) {
    clearTimeout(dashboardUpdateTimeout);
  }
  dashboardUpdateTimeout = setTimeout(async () => {
    try {
      const stats = await monitoringService.getDashboardStats();
      broadcast('dashboard:update', stats);
    } catch (error: any) {
      logger.error(`Dashboard broadcast error: ${error.message}`);
    }
  }, 1000);
}

export function getIO(): SocketServer | null {
  return io;
}
