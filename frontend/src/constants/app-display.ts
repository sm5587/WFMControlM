export const APP_NAME_CONFIG_KEY = 'display.appName';
export const DEFAULT_APP_NAME = 'Workcloud Pulse';

export const DEPLOYMENT_LABEL_CONFIG_KEY = 'display.deploymentLabel';
export const DEFAULT_DEPLOYMENT_LABEL = 'Local';

/** Admin → Config: set to true to show the Ad-hoc Windows tab on Maintenance. */
export const MAINTENANCE_ADHOC_WINDOWS_KEY = 'display.maintenanceAdHocWindows';

/** Admin → Config: set to true to show Payroll Jobs menu and API (initial rollout: false). */
export const PAYROLL_ENABLED_KEY = 'display.payrollEnabled';

/** Admin → Config: set to true to show Payroll Monitor menu and API (initial rollout: false). */
export const PAYROLL_MONITOR_ENABLED_KEY = 'display.payrollMonitorEnabled';

/** Admin → Config: set to true to show Heat Map menu and API. */
export const HEATMAP_ENABLED_KEY = 'display.heatMapEnabled';
/** @deprecated Prefer HEATMAP_ENABLED_KEY — kept for one-release config migration. */
export const LEGACY_WIP_HEATMAP_ENABLED_KEY = 'display.wipHeatMapEnabled';

/**
 * Admin → Config: JSON array of external tool links for the top-bar waffle menu.
 * Shape: [{ "label": "JIRA", "url": "https://...", "icon"?: "ticket", "enabled"?: true }]
 * Empty [] hides the menu.
 */
export const EXTERNAL_TOOLS_KEY = 'display.externalTools';
export const DEFAULT_EXTERNAL_TOOLS_JSON = '[]';
