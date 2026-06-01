import React, { createContext, useContext, useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clientsApi } from '../services/api';
import { Client } from '../types';
import { useAuth } from './AuthContext';

interface GlobalFilterContextType {
  selectedCluster: string;
  selectedClientId: string;
  setSelectedCluster: (v: string) => void;
  setSelectedClientId: (v: string) => void;
  clients: Client[];
  clusters: string[];
  isLoading: boolean;
  clearFilters: () => void;
}

const GlobalFilterContext = createContext<GlobalFilterContextType>({
  selectedCluster: '',
  selectedClientId: '',
  setSelectedCluster: () => {},
  setSelectedClientId: () => {},
  clients: [],
  clusters: [],
  isLoading: false,
  clearFilters: () => {},
});

export function GlobalFilterProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [selectedCluster, setSelectedClusterState] = useState('');
  const [selectedClientId, setSelectedClientId] = useState('');

  // Reset filters when user changes (new login)
  useEffect(() => {
    setSelectedClusterState('');
    setSelectedClientId('');
  }, [user?.id]);

  const { data: clientsData, isLoading } = useQuery({
    queryKey: ['clients-all-global', user?.id],
    queryFn: () => clientsApi.list({ isActive: true, pageSize: 10000 }),
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const clients = (clientsData?.data || []) as Client[];

  const clusters = useMemo(() => {
    const set = new Set<string>();
    clients.forEach(c => { if (c.cluster) set.add(c.cluster); });
    return Array.from(set).sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, '')) || 0;
      const numB = parseInt(b.replace(/\D/g, '')) || 0;
      return numA - numB || a.localeCompare(b);
    });
  }, [clients]);

  const setSelectedCluster = (v: string) => {
    setSelectedClusterState(v);
    // Clear client selection if it no longer belongs to the chosen cluster
    if (v && selectedClientId) {
      const client = clients.find(c => c.id === selectedClientId);
      if (client && client.cluster !== v) {
        setSelectedClientId('');
      }
    }
  };

  const clearFilters = () => {
    setSelectedClusterState('');
    setSelectedClientId('');
  };

  return (
    <GlobalFilterContext.Provider value={{
      selectedCluster,
      selectedClientId,
      setSelectedCluster,
      setSelectedClientId,
      clients,
      clusters,
      isLoading,
      clearFilters,
    }}>
      {children}
    </GlobalFilterContext.Provider>
  );
}

export function useGlobalFilter() {
  return useContext(GlobalFilterContext);
}
