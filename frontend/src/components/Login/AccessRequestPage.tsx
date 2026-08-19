import React from 'react';
import { Activity, Clock, ShieldCheck, ShieldX, Mail } from 'lucide-react';
import { useAppName } from '../../contexts/ConfigContext';
import { instanceUrlHint } from '../DeploymentBadge';

export interface SsoAccessStatus {
  ssoEnabled: boolean;
  email: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ACTIVE' | 'DOMAIN_DENIED' | null;
  canLogin: boolean;
  displayName?: string | null;
  message?: string;
}

interface Props {
  status: SsoAccessStatus;
}

export default function AccessRequestPage({ status }: Props) {
  const appName = useAppName();
  const email = status.email || '';
  const isPending = status.status === 'PENDING';
  const isRejected = status.status === 'REJECTED';
  const isDomainDenied = status.status === 'DOMAIN_DENIED';

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Activity className="w-10 h-10 text-zebra-400" />
            <div className="text-left">
              <h1 className="text-2xl font-bold text-white tracking-tight">{appName}</h1>
              <p className="text-xs text-slate-400 font-mono">{instanceUrlHint()}</p>
            </div>
          </div>
        </div>

        {/* Card */}
        <div className="bg-slate-800 rounded-xl shadow-2xl p-10 border border-slate-700">
          {isPending && (
            <>
              <div className="mx-auto w-14 h-14 rounded-full bg-amber-900/40 border border-amber-700/50 flex items-center justify-center mb-6">
                <Clock className="w-7 h-7 text-amber-400" />
              </div>
              <h2 className="text-xl font-semibold text-white mb-3">Access Request Submitted</h2>
              <p className="text-slate-300 text-sm leading-relaxed mb-6">
                Thank you for requesting access to {appName}. Your request has been sent to the
                administrator for review. You will be able to sign in once your account is approved
                and a profile has been assigned.
              </p>
            </>
          )}

          {isDomainDenied && (
            <>
              <div className="mx-auto w-14 h-14 rounded-full bg-red-900/40 border border-red-700/50 flex items-center justify-center mb-6">
                <ShieldX className="w-7 h-7 text-red-400" />
              </div>
              <h2 className="text-xl font-semibold text-white mb-3">Access Not Permitted</h2>
              <p className="text-slate-300 text-sm leading-relaxed mb-6">
                {status.message ||
                  'Access is restricted to Zebra corporate (@zebra.com) accounts only.'}
              </p>
            </>
          )}

          {isRejected && (
            <>
              <div className="mx-auto w-14 h-14 rounded-full bg-red-900/40 border border-red-700/50 flex items-center justify-center mb-6">
                <ShieldX className="w-7 h-7 text-red-400" />
              </div>
              <h2 className="text-xl font-semibold text-white mb-3">Access Not Granted</h2>
              <p className="text-slate-300 text-sm leading-relaxed mb-6">
                {status.message ||
                  'Your access request was not approved. Please contact your administrator if you believe this is an error.'}
              </p>
            </>
          )}

          {!isPending && !isRejected && status.message && (
            <>
              <div className="mx-auto w-14 h-14 rounded-full bg-slate-700/60 border border-slate-600 flex items-center justify-center mb-6">
                <ShieldCheck className="w-7 h-7 text-slate-400" />
              </div>
              <h2 className="text-xl font-semibold text-white mb-3">Access Pending Setup</h2>
              <p className="text-slate-300 text-sm leading-relaxed mb-6">{status.message}</p>
            </>
          )}

          {email && (
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-700/60 border border-slate-600 text-sm text-slate-300">
              <Mail className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <span>{email}</span>
            </div>
          )}

          {isPending && (
            <p className="mt-8 text-xs text-slate-500">
              No further action is needed on your part. You may close this page and try again later.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
