// ============================================================
// WebSocket Hook - Real-time updates (cookie-authenticated)
// ============================================================

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useConfig } from '../contexts/ConfigContext';
import { useAuth } from '../context/AuthContext';

interface WSEvent {
  type: string;
  payload: any;
  timestamp: string;
}

export function useWebSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null);
  const listenersRef = useRef<Map<string, Set<(data: any) => void>>>(new Map());
  const { getInt } = useConfig();
  const { user } = useAuth();

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setIsConnected(false);
      return;
    }

    const socket = io(window.location.origin, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionAttempts: getInt('display.wsReconnectAttempts', 10),
      reconnectionDelay: getInt('display.wsReconnectDelayMs', 1000),
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('connect_error', (err) => {
      setIsConnected(false);
      if (
        err.message === 'Authentication required'
        || err.message === 'Invalid or expired token'
        || err.message === 'Session revoked'
      ) {
        socket.disconnect();
      }
    });

    const eventTypes = [
      'execution:started', 'execution:progress', 'execution:completed', 'execution:failed',
      'alert:triggered', 'dashboard:update',
    ];

    for (const eventType of eventTypes) {
      socket.on(eventType, (data: WSEvent) => {
        setLastEvent(data);
        const listeners = listenersRef.current.get(eventType);
        if (listeners) {
          listeners.forEach(cb => cb(data));
        }
      });
    }

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user, getInt]);

  const subscribe = useCallback((event: string, callback: (data: any) => void) => {
    if (!listenersRef.current.has(event)) {
      listenersRef.current.set(event, new Set());
    }
    listenersRef.current.get(event)!.add(callback);

    return () => {
      listenersRef.current.get(event)?.delete(callback);
    };
  }, []);

  const emit = useCallback((event: string, data?: any) => {
    socketRef.current?.emit(event, data);
  }, []);

  const followExecution = useCallback((executionId: string) => {
    socketRef.current?.emit('execution:follow', executionId);
    return () => {
      socketRef.current?.emit('execution:unfollow', executionId);
    };
  }, []);

  const requestDashboardRefresh = useCallback(() => {
    socketRef.current?.emit('dashboard:refresh');
  }, []);

  return {
    isConnected,
    lastEvent,
    subscribe,
    emit,
    followExecution,
    requestDashboardRefresh,
  };
}
