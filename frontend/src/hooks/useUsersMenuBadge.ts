import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../services/api';
import { useConfig } from '../contexts/ConfigContext';
import { useAuth } from '../context/AuthContext';

/**
 * Whether the Users admin nav item should show its attention indicator.
 * Active when there is at least one PENDING access request (SSO/LDAP first login).
 */
export function useUsersMenuBadge() {
  const { getInt } = useConfig();
  const { canRead } = useAuth();
  const enabled = canRead('USERS_VIEW');

  const { data = [] } = useQuery({
    queryKey: ['admin-access-requests', 'PENDING'],
    queryFn: async () => {
      const res = await adminApi.getAccessRequests('PENDING');
      return res.data ?? [];
    },
    enabled,
    refetchInterval: getInt('polling.escalatedRefreshSecs', 60) * 1000,
    refetchOnWindowFocus: true,
  });

  const count = data.length;
  return { showBadge: enabled && count > 0, count };
}
