// ============================================================
// Job Executor - Executes individual jobs
// ============================================================

import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import http from 'http';
import { createServiceLogger } from '../utils/logger';
import { ExecutionResult, HttpJobConfig, RetryPolicy, JobType } from '../models/types';
import { prisma } from '../database/prisma';
import { configService } from '../services/config-service';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);
const logger = createServiceLogger('Executor');

export class JobExecutor extends EventEmitter {
  private runningProcesses: Map<string, ChildProcess> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();

  constructor() {
    super();
  }

  /**
   * Execute a job based on its type
   */
  async execute(
    executionId: string,
    jobType: JobType,
    config: {
      command?: string;
      scriptPath?: string;
      httpConfig?: HttpJobConfig;
      parameters?: Record<string, any>;
      environment?: Record<string, string>;
      timeout: number;
    }
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    logger.info(`Starting execution: ${executionId}, type: ${jobType}`);

    try {
      // Update status to RUNNING
      await prisma.jobExecution.update({
        where: { id: executionId },
        data: { status: 'RUNNING', startedAt: new Date() },
      });

      this.emit('execution:started', { executionId });

      let result: ExecutionResult;

      switch (jobType) {
        case 'COMMAND':
          result = await this.executeCommand(executionId, config.command!, config.environment, config.timeout);
          break;
        case 'SCRIPT':
          result = await this.executeScript(executionId, config.scriptPath!, config.parameters, config.environment, config.timeout);
          break;
        case 'HTTP':
          result = await this.executeHttp(executionId, config.httpConfig!, config.timeout);
          break;
        case 'DATA_PIPELINE':
          result = await this.executeDataPipeline(executionId, config.command!, config.parameters, config.timeout);
          break;
        case 'FORECAST':
          result = await this.executeForecast(executionId, config.parameters, config.timeout);
          break;
        case 'SCHEDULE_GEN':
          result = await this.executeScheduleGeneration(executionId, config.parameters, config.timeout);
          break;
        default:
          result = await this.executeCommand(executionId, config.command || 'echo "No command specified"', config.environment, config.timeout);
      }

      const duration = Math.floor((Date.now() - startTime) / 1000);
      result.duration = duration;

      // Update execution record
      await prisma.jobExecution.update({
        where: { id: executionId },
        data: {
          status: result.success ? 'SUCCESS' : 'FAILED',
          completedAt: new Date(),
          duration,
          exitCode: result.exitCode,
          output: result.output?.substring(0, configService.getInt('engine.maxOutputChars')),
          errorMessage: result.errorMessage?.substring(0, configService.getInt('engine.maxErrorChars')),
          memoryUsageMb: result.memoryUsageMb,
          cpuPercent: result.cpuPercent,
        },
      });

      this.emit(result.success ? 'execution:completed' : 'execution:failed', {
        executionId,
        result,
      });

      logger.info(`Execution ${executionId} ${result.success ? 'succeeded' : 'failed'} in ${duration}s`);
      return result;
    } catch (error: any) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const result: ExecutionResult = {
        success: false,
        exitCode: -1,
        output: '',
        errorMessage: error.message,
        duration,
      };

      await prisma.jobExecution.update({
        where: { id: executionId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          duration,
          exitCode: -1,
          errorMessage: error.message,
        },
      });

      this.emit('execution:failed', { executionId, result });
      logger.error(`Execution ${executionId} error: ${error.message}`);
      return result;
    } finally {
      this.runningProcesses.delete(executionId);
      this.abortControllers.delete(executionId);
    }
  }

  /**
   * Execute a shell command
   */
  private async executeCommand(
    executionId: string,
    command: string,
    environment?: Record<string, string>,
    timeout: number = 3600
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const env = { ...process.env, ...environment };
      const child = spawn('sh', ['-c', command], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeout * 1000,
      });

      this.runningProcesses.set(executionId, child);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        this.emit('execution:progress', { executionId, output: chunk });
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code: number | null) => {
        resolve({
          success: code === 0,
          exitCode: code ?? -1,
          output: stdout,
          errorMessage: stderr || undefined,
          duration: 0,
        });
      });

      child.on('error', (err: Error) => {
        resolve({
          success: false,
          exitCode: -1,
          output: stdout,
          errorMessage: err.message,
          duration: 0,
        });
      });
    });
  }

  /**
   * Execute a script file
   */
  private async executeScript(
    executionId: string,
    scriptPath: string,
    parameters?: Record<string, any>,
    environment?: Record<string, string>,
    timeout: number = 3600
  ): Promise<ExecutionResult> {
    // Determine interpreter from extension
    let interpreter = 'sh';
    if (scriptPath.endsWith('.py')) interpreter = 'python3';
    else if (scriptPath.endsWith('.js')) interpreter = 'node';
    else if (scriptPath.endsWith('.ps1')) interpreter = 'powershell';

    // Build args from parameters
    const args = parameters
      ? Object.entries(parameters).map(([k, v]) => `--${k}=${v}`)
      : [];

    const command = `${interpreter} ${scriptPath} ${args.join(' ')}`;
    return this.executeCommand(executionId, command, environment, timeout);
  }

  /**
   * Execute an HTTP request
   */
  private async executeHttp(
    executionId: string,
    httpConfig: HttpJobConfig,
    timeout: number = 300
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const url = new URL(httpConfig.url);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: httpConfig.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...httpConfig.headers,
        },
        timeout: (httpConfig.timeout || timeout) * 1000,
      };

      const req = client.request(options, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          const statusCode = res.statusCode || 0;
          const expectedCodes = httpConfig.expectedStatusCodes || [200, 201, 202, 204];
          const success = expectedCodes.includes(statusCode);

          resolve({
            success,
            exitCode: statusCode,
            output: `HTTP ${statusCode} ${res.statusMessage}\n\n${body}`,
            errorMessage: success ? undefined : `Unexpected status code: ${statusCode}`,
            duration: Math.floor((Date.now() - startTime) / 1000),
          });
        });
      });

      req.on('error', (err: Error) => {
        resolve({
          success: false,
          exitCode: -1,
          output: '',
          errorMessage: `HTTP request failed: ${err.message}`,
          duration: Math.floor((Date.now() - startTime) / 1000),
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          exitCode: -1,
          output: '',
          errorMessage: 'HTTP request timed out',
          duration: Math.floor((Date.now() - startTime) / 1000),
        });
      });

      if (httpConfig.body && ['POST', 'PUT', 'PATCH'].includes(httpConfig.method)) {
        req.write(typeof httpConfig.body === 'string' ? httpConfig.body : JSON.stringify(httpConfig.body));
      }

      req.end();
    });
  }

  /**
   * Execute a data pipeline job (ETL, data imports)
   */
  private async executeDataPipeline(
    executionId: string,
    command: string,
    parameters?: Record<string, any>,
    timeout: number = 7200
  ): Promise<ExecutionResult> {
    logger.info(`Executing data pipeline: ${executionId}`);

    // Data pipeline jobs are typically long-running ETL processes
    // They can be shell commands, Python scripts, or custom executables
    const env: Record<string, string> = {};
    if (parameters) {
      // Pass parameters as environment variables prefixed with WFM_
      for (const [key, value] of Object.entries(parameters)) {
        env[`WFM_${key.toUpperCase()}`] = String(value);
      }
    }

    return this.executeCommand(executionId, command, env, timeout);
  }

  /**
   * Execute WFM forecast generation
   */
  private async executeForecast(
    executionId: string,
    parameters?: Record<string, any>,
    timeout: number = 3600
  ): Promise<ExecutionResult> {
    logger.info(`Executing forecast generation: ${executionId}`, { parameters });

    // This would integrate with your WFM system's forecast API
    // For now, we demonstrate the structure
    const forecastParams = {
      startDate: parameters?.startDate || new Date().toISOString().split('T')[0],
      endDate: parameters?.endDate || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
      forecastType: parameters?.forecastType || 'demand',
      skillGroups: parameters?.skillGroups || [],
      algorithm: parameters?.algorithm || 'auto',
      ...parameters,
    };

    // In production, this would call your WFM API:
    // const result = await wfmClient.generateForecast(forecastParams);
    
    // Placeholder - replace with actual WFM API integration
    const command = parameters?.command || `echo "Forecast generation: ${JSON.stringify(forecastParams)}"`;
    const env = {
      WFM_FORECAST_START: forecastParams.startDate,
      WFM_FORECAST_END: forecastParams.endDate,
      WFM_FORECAST_TYPE: forecastParams.forecastType,
      WFM_FORECAST_ALGORITHM: forecastParams.algorithm,
    };

    return this.executeCommand(executionId, command, env, timeout);
  }

  /**
   * Execute WFM schedule generation
   */
  private async executeScheduleGeneration(
    executionId: string,
    parameters?: Record<string, any>,
    timeout: number = 7200
  ): Promise<ExecutionResult> {
    logger.info(`Executing schedule generation: ${executionId}`, { parameters });

    const scheduleParams = {
      startDate: parameters?.startDate || new Date().toISOString().split('T')[0],
      endDate: parameters?.endDate || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
      scheduleType: parameters?.scheduleType || 'optimal',
      agentGroups: parameters?.agentGroups || [],
      constraints: parameters?.constraints || {},
      ...parameters,
    };

    // In production, this would call your WFM scheduling optimizer
    const command = parameters?.command || `echo "Schedule generation: ${JSON.stringify(scheduleParams)}"`;
    const env = {
      WFM_SCHEDULE_START: scheduleParams.startDate,
      WFM_SCHEDULE_END: scheduleParams.endDate,
      WFM_SCHEDULE_TYPE: scheduleParams.scheduleType,
    };

    return this.executeCommand(executionId, command, env, timeout);
  }

  /**
   * Execute with retry policy
   */
  async executeWithRetry(
    executionId: string,
    jobType: JobType,
    config: {
      command?: string;
      scriptPath?: string;
      httpConfig?: HttpJobConfig;
      parameters?: Record<string, any>;
      environment?: Record<string, string>;
      timeout: number;
    },
    retryPolicy?: RetryPolicy
  ): Promise<ExecutionResult> {
    const maxAttempts = retryPolicy ? retryPolicy.maxRetries + 1 : 1;
    let lastResult: ExecutionResult | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Update attempt number
      await prisma.jobExecution.update({
        where: { id: executionId },
        data: { attempt, maxAttempts },
      });

      lastResult = await this.execute(executionId, jobType, config);

      if (lastResult.success) {
        return lastResult;
      }

      // Check if we should retry
      if (attempt < maxAttempts) {
        const delay = retryPolicy!.retryDelay * Math.pow(retryPolicy!.backoffMultiplier, attempt - 1);
        logger.info(`Execution ${executionId} failed, retrying in ${delay}s (attempt ${attempt}/${maxAttempts})`);

        await prisma.jobExecution.update({
          where: { id: executionId },
          data: { status: 'RETRY_PENDING' },
        });

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay * 1000));

        // Reset status for retry
        await prisma.jobExecution.update({
          where: { id: executionId },
          data: { status: 'PENDING', startedAt: null, completedAt: null },
        });
      }
    }

    return lastResult!;
  }

  /**
   * Cancel a running execution
   */
  async cancel(executionId: string): Promise<boolean> {
    const process = this.runningProcesses.get(executionId);
    if (process) {
      process.kill('SIGTERM');
      
      // Give it 10 seconds to gracefully terminate
      setTimeout(() => {
        if (this.runningProcesses.has(executionId)) {
          process.kill('SIGKILL');
        }
      }, 10000);

      await prisma.jobExecution.update({
        where: { id: executionId },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          errorMessage: 'Cancelled by user',
        },
      });

      this.emit('execution:cancelled', { executionId });
      logger.info(`Execution ${executionId} cancelled`);
      return true;
    }

    const controller = this.abortControllers.get(executionId);
    if (controller) {
      controller.abort();
      return true;
    }

    return false;
  }

  /**
   * Get currently running execution count
   */
  getRunningCount(): number {
    return this.runningProcesses.size;
  }

  /**
   * Get running execution IDs
   */
  getRunningExecutions(): string[] {
    return Array.from(this.runningProcesses.keys());
  }
}

// Singleton instance
export const jobExecutor = new JobExecutor();
