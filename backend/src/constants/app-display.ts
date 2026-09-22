/** AppConfig key for the product display name (emails, UI, health). */
export const APP_NAME_CONFIG_KEY = 'display.appName';

export const DEFAULT_APP_NAME = 'WFM Watch';

/** Admin → Config: set to true to show Payroll Jobs menu and API (initial rollout: false). */
export const PAYROLL_ENABLED_KEY = 'display.payrollEnabled';

/** Admin → Config: set to true to show Payroll Monitor menu and API (initial rollout: false). */
export const PAYROLL_MONITOR_ENABLED_KEY = 'display.payrollMonitorEnabled';

/** Non-secret display toggles exposed on /api/deployment-info for instant menu rendering. */
export const DISPLAY_MENU_FLAG_KEYS = [
  APP_NAME_CONFIG_KEY,
  PAYROLL_ENABLED_KEY,
  PAYROLL_MONITOR_ENABLED_KEY,
  'display.maintenanceAdHocWindows',
  'display.showUnprocPunchTab',
] as const;
