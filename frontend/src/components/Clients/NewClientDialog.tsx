import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  X, Plus, Trash2, Server, Database, Info, Globe,
  ChevronRight, CheckCircle, AlertCircle,
} from 'lucide-react';
import { clientsApi } from '../../services/api';

// ── Types ───────────────────────────────────────────────────────────────────

interface AppServerRow {
  environment: 'Prod' | 'PP';
  serverNum: string;
  dns: string;
  sshPort: number;
}

interface FormData {
  // Identity
  clientId: string;
  name: string;
  description: string;
  cluster: string;
  timezone: string;
  isActive: boolean;
  whiteGlove: boolean;
  owner: string;
  team: string;
  // App Servers
  appServers: AppServerRow[];
  // DB2
  db2Host: string;
  db2Port: number;
  db2Database: string;
  db2Schema: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const COMMON_TIMEZONES = [
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Sao_Paulo',
  'America/Mexico_City',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Buenos_Aires',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Warsaw',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Australia/Perth',
  'Pacific/Auckland',
];

const STEP_LABELS = ['Identity', 'App Servers', 'DB2 Connection', 'Review'];

const EMPTY_FORM: FormData = {
  clientId: '',
  name: '',
  description: '',
  cluster: '',
  timezone: 'America/Chicago',
  isActive: true,
  whiteGlove: false,
  owner: '',
  team: '',
  appServers: [{ environment: 'Prod', serverNum: '01', dns: '', sshPort: 22 }],
  db2Host: '',
  db2Port: 50000,
  db2Database: '',
  db2Schema: '',
};

// ── Helper ───────────────────────────────────────────────────────────────────

function labelClass(required?: boolean) {
  return `block text-xs font-semibold text-gray-600 mb-1 ${required ? "after:content-['*'] after:text-red-500 after:ml-0.5" : ''}`;
}

function inputClass(error?: boolean) {
  return `w-full px-3 py-2 border ${error ? 'border-red-400 bg-red-50' : 'border-gray-200'} rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300`;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function NewClientDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [submitError, setSubmitError] = useState('');

  const createMutation = useMutation({
    mutationFn: () =>
      clientsApi.create({
        clientId: form.clientId.trim().toUpperCase(),
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        cluster: form.cluster.trim(),
        timezone: form.timezone,
        isActive: form.isActive,
        whiteGlove: form.whiteGlove,
        owner: form.owner.trim() || undefined,
        team: form.team.trim() || undefined,
        db2Host: form.db2Host.trim() || undefined,
        db2Port: form.db2Host.trim() ? form.db2Port : undefined,
        db2Database: form.db2Database.trim() || undefined,
        db2Schema: form.db2Schema.trim() || undefined,
        appServers: form.appServers
          .filter(s => s.dns.trim())
          .map(s => ({ ...s, dns: s.dns.trim() })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      onClose();
    },
    onError: (err: any) => {
      setSubmitError(err?.response?.data?.error || err.message || 'Failed to create client');
    },
  });

  // ── Field helpers ──────────────────────────────────────────────────────────

  const set = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setForm(f => ({ ...f, [key]: value }));
    setErrors(e => { const n = { ...e }; delete n[key]; return n; });
  };

  const setServer = (idx: number, key: keyof AppServerRow, value: any) => {
    setForm(f => {
      const servers = [...f.appServers];
      servers[idx] = { ...servers[idx], [key]: value };
      return { ...f, appServers: servers };
    });
    setErrors(e => { const n = { ...e }; delete n[`server_${idx}_dns`]; return n; });
  };

  const addServer = () => {
    setForm(f => ({
      ...f,
      appServers: [
        ...f.appServers,
        { environment: 'Prod', serverNum: String(f.appServers.length + 1).padStart(2, '0'), dns: '', sshPort: 22 },
      ],
    }));
  };

  const removeServer = (idx: number) => {
    setForm(f => ({ ...f, appServers: f.appServers.filter((_, i) => i !== idx) }));
  };

  // ── Validation per step ────────────────────────────────────────────────────

  function validateStep(s: number): boolean {
    const errs: Partial<Record<string, string>> = {};

    if (s === 0) {
      if (!form.clientId.trim()) errs.clientId = 'Required';
      else if (!/^[A-Z0-9_-]+$/i.test(form.clientId.trim())) errs.clientId = 'Alphanumeric only (A–Z, 0–9, _ -)';
      if (!form.name.trim()) errs.name = 'Required';
    }

    if (s === 1) {
      form.appServers.forEach((srv, i) => {
        if (!srv.dns.trim()) errs[`server_${i}_dns`] = 'DNS hostname required';
      });
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function next() {
    if (validateStep(step)) setStep(s => s + 1);
  }

  function back() { setStep(s => s - 1); }

  // ── Derived ────────────────────────────────────────────────────────────────

  const filledServers = form.appServers.filter(s => s.dns.trim());

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">New Client</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Step {step + 1} of {STEP_LABELS.length} — {STEP_LABELS[step]}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1 px-6 py-3 border-b border-gray-50 bg-gray-50/60">
          {STEP_LABELS.map((label, i) => (
            <React.Fragment key={label}>
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                i === step ? 'bg-zebra-600 text-white' :
                i < step ? 'bg-green-100 text-green-700' :
                'bg-gray-100 text-gray-400'
              }`}>
                {i < step ? <CheckCircle className="w-3 h-3" /> : <span>{i + 1}</span>}
                {label}
              </div>
              {i < STEP_LABELS.length - 1 && <ChevronRight className="w-3 h-3 text-gray-300 flex-shrink-0" />}
            </React.Fragment>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* ── Step 0: Identity ───────────────────────────────────────────── */}
          {step === 0 && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass(true)}>Client ID</label>
                  <input
                    className={inputClass(!!errors.clientId)}
                    placeholder="e.g. NEWCO"
                    value={form.clientId}
                    onChange={e => set('clientId', e.target.value.toUpperCase())}
                    maxLength={20}
                  />
                  {errors.clientId && <p className="text-xs text-red-500 mt-1">{errors.clientId}</p>}
                  <p className="text-xs text-gray-400 mt-1">Short code used as primary key (uppercase)</p>
                </div>
                <div>
                  <label className={labelClass(true)}>Display Name</label>
                  <input
                    className={inputClass(!!errors.name)}
                    placeholder="e.g. NewCo Retail"
                    value={form.name}
                    onChange={e => set('name', e.target.value)}
                    maxLength={120}
                  />
                  {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
                </div>
              </div>

              <div>
                <label className={labelClass()}>Description</label>
                <textarea
                  className={inputClass()}
                  placeholder="Optional notes about this client..."
                  rows={2}
                  value={form.description}
                  onChange={e => set('description', e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass()}>Cluster</label>
                  <input
                    className={inputClass()}
                    placeholder="e.g. CL01"
                    value={form.cluster}
                    onChange={e => set('cluster', e.target.value.toUpperCase())}
                    maxLength={10}
                  />
                  <p className="text-xs text-gray-400 mt-1">Server cluster group (CL01–CL85)</p>
                </div>
                <div>
                  <label className={labelClass()}>Timezone</label>
                  <select
                    className={inputClass()}
                    value={form.timezone}
                    onChange={e => set('timezone', e.target.value)}
                  >
                    {COMMON_TIMEZONES.map(tz => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mt-1">Will be overwritten when TZ detection runs via SSH</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass()}>Owner</label>
                  <input
                    className={inputClass()}
                    placeholder="e.g. john.doe@zebra.com"
                    value={form.owner}
                    onChange={e => set('owner', e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelClass()}>Team</label>
                  <input
                    className={inputClass()}
                    placeholder="e.g. WFM North America"
                    value={form.team}
                    onChange={e => set('team', e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={e => set('isActive', e.target.checked)}
                    className="w-4 h-4 rounded accent-zebra-600"
                  />
                  <span className="text-sm text-gray-700">Active</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.whiteGlove}
                    onChange={e => set('whiteGlove', e.target.checked)}
                    className="w-4 h-4 rounded accent-amber-500"
                  />
                  <span className="text-sm text-gray-700">White Glove (priority client)</span>
                </label>
              </div>
            </div>
          )}

          {/* ── Step 1: App Servers ────────────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  Add the WAS (WebSphere Application Server) hosts. At least one <strong>Prod</strong> server is required for cron sync and timezone detection via SSH. SSH uses keyboard-interactive auth (password + TOTP).
                </span>
              </div>

              <div className="space-y-3">
                {form.appServers.map((srv, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-start p-3 bg-gray-50 rounded-lg border border-gray-100">
                    <div className="col-span-2">
                      <label className={labelClass(true)}>Env</label>
                      <select
                        className={inputClass()}
                        value={srv.environment}
                        onChange={e => setServer(i, 'environment', e.target.value as 'Prod' | 'PP')}
                      >
                        <option value="Prod">Prod</option>
                        <option value="PP">PP</option>
                      </select>
                    </div>
                    <div className="col-span-1">
                      <label className={labelClass()}>Num</label>
                      <input
                        className={inputClass()}
                        value={srv.serverNum}
                        onChange={e => setServer(i, 'serverNum', e.target.value)}
                        maxLength={4}
                        placeholder="01"
                      />
                    </div>
                    <div className="col-span-6">
                      <label className={labelClass(true)}>DNS Hostname</label>
                      <input
                        className={inputClass(!!errors[`server_${i}_dns`])}
                        placeholder="z182sp-{client}rwsprwas01.rfx.zebra.com"
                        value={srv.dns}
                        onChange={e => setServer(i, 'dns', e.target.value.trim())}
                      />
                      {errors[`server_${i}_dns`] && (
                        <p className="text-xs text-red-500 mt-1">{errors[`server_${i}_dns`]}</p>
                      )}
                    </div>
                    <div className="col-span-2">
                      <label className={labelClass()}>SSH Port</label>
                      <input
                        type="number"
                        className={inputClass()}
                        value={srv.sshPort}
                        onChange={e => setServer(i, 'sshPort', parseInt(e.target.value) || 22)}
                        min={1}
                        max={65535}
                      />
                    </div>
                    <div className="col-span-1 flex items-end pb-0.5">
                      <button
                        onClick={() => removeServer(i)}
                        disabled={form.appServers.length === 1}
                        className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-30"
                        title="Remove server"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={addServer}
                className="flex items-center gap-2 px-3 py-2 text-sm text-zebra-600 border border-dashed border-zebra-300 hover:bg-zebra-50 rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add another server
              </button>
            </div>
          )}

          {/* ── Step 2: DB2 Connection ─────────────────────────────────────── */}
          {step === 2 && (
            <div className="space-y-5">
              <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>
                  DB2 is used for payroll sync and job execution history. Leave blank if DB2 access is not yet configured — you can update it later.
                </span>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className={labelClass()}>DB2 Host</label>
                  <input
                    className={inputClass()}
                    placeholder="db2host.rfx.zebra.com"
                    value={form.db2Host}
                    onChange={e => set('db2Host', e.target.value.trim())}
                  />
                </div>
                <div>
                  <label className={labelClass()}>Port</label>
                  <input
                    type="number"
                    className={inputClass()}
                    value={form.db2Port}
                    onChange={e => set('db2Port', parseInt(e.target.value) || 50000)}
                    min={1}
                    max={65535}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass()}>Database Name</label>
                  <input
                    className={inputClass()}
                    placeholder="e.g. WFMDB"
                    value={form.db2Database}
                    onChange={e => set('db2Database', e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelClass()}>Schema</label>
                  <input
                    className={inputClass()}
                    placeholder="e.g. WFMUSER"
                    value={form.db2Schema}
                    onChange={e => set('db2Schema', e.target.value)}
                  />
                  <p className="text-xs text-gray-400 mt-1">DB2 schema used for payroll / RTA integration queries</p>
                </div>
              </div>
            </div>
          )}

          {/* ── Step 3: Review ─────────────────────────────────────────────── */}
          {step === 3 && (
            <div className="space-y-4">
              <ReviewSection title="Client Identity" icon={<Globe className="w-4 h-4 text-indigo-500" />}>
                <ReviewRow label="Client ID" value={form.clientId.toUpperCase()} mono />
                <ReviewRow label="Name" value={form.name} />
                {form.description && <ReviewRow label="Description" value={form.description} />}
                <ReviewRow label="Cluster" value={form.cluster || '—'} />
                <ReviewRow label="Timezone" value={form.timezone} />
                {form.owner && <ReviewRow label="Owner" value={form.owner} />}
                {form.team && <ReviewRow label="Team" value={form.team} />}
                <ReviewRow label="Active" value={form.isActive ? 'Yes' : 'No'} />
                <ReviewRow label="White Glove" value={form.whiteGlove ? 'Yes' : 'No'} />
              </ReviewSection>

              <ReviewSection title="App Servers" icon={<Server className="w-4 h-4 text-green-500" />}>
                {filledServers.length === 0 ? (
                  <p className="text-xs text-amber-600 col-span-2">No servers added — cron sync will not be available</p>
                ) : (
                  filledServers.map((s, i) => (
                    <ReviewRow
                      key={i}
                      label={`${s.environment} / ${s.serverNum}`}
                      value={`${s.dns}  :${s.sshPort}`}
                      mono
                    />
                  ))
                )}
              </ReviewSection>

              <ReviewSection title="DB2 Connection" icon={<Database className="w-4 h-4 text-purple-500" />}>
                {form.db2Host ? (
                  <>
                    <ReviewRow label="Host" value={`${form.db2Host}:${form.db2Port}`} mono />
                    <ReviewRow label="Database" value={form.db2Database || '—'} />
                    <ReviewRow label="Schema" value={form.db2Schema || '—'} />
                  </>
                ) : (
                  <p className="text-xs text-gray-400 col-span-2">Not configured</p>
                )}
              </ReviewSection>

              {submitError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {submitError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50/60">
          <button
            onClick={step === 0 ? onClose : back}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          <div className="text-xs text-gray-400">
            {step < 3 ? `${STEP_LABELS.length - step - 1} step${STEP_LABELS.length - step - 1 !== 1 ? 's' : ''} remaining` : ''}
          </div>
          {step < 3 ? (
            <button
              onClick={next}
              className="px-5 py-2 text-sm bg-zebra-600 text-white rounded-lg hover:bg-zebra-700 transition-colors font-medium"
            >
              Next →
            </button>
          ) : (
            <button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              className="px-5 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating...' : 'Create Client'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Small review sub-components ──────────────────────────────────────────────

function ReviewSection({
  title, icon, children,
}: {
  title: string; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-100">
        {icon}
        <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">{title}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3">
        {children}
      </div>
    </div>
  );
}

function ReviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-xs text-gray-800 font-medium ${mono ? 'font-mono' : ''} break-all`}>{value}</span>
    </>
  );
}
